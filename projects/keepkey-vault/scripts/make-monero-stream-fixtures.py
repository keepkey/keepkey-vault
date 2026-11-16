"""Extract public assembly fixtures from monero_tx_vectors_gen.sh's Core-verified records.

Usage: python3 scripts/make-monero-stream-fixtures.py RECORDS PROTO_DIR
Needs protoc, Python protobuf and cryptography. Does not run firmware or access a device.
The signed blobs are unchanged firmware vectors. Protocol envelopes are reconstructed
from their public pieces; MAC tokens and the AEAD opening key are test-only values,
not captured device credentials. Encoding comes from protoc, independently of TS.
"""
import hashlib
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory
from types import SimpleNamespace
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

# Keccak-f[1600], legacy Keccak padding (not SHA3).
RC = [0x1,0x8082,0x800000000000808a,0x8000000080008000,0x808b,0x80000001,0x8000000080008081,0x8000000000008009,0x8a,0x88,0x80008009,0x8000000a,0x8000808b,0x800000000000008b,0x8000000000008089,0x8000000000008003,0x8000000000008002,0x8000000000000080,0x800a,0x800000008000000a,0x8000000080008081,0x8000000000008080,0x80000001,0x8000000080008008]
ROT = [0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14]
MASK = (1 << 64) - 1

def keccak(data):
    padded = bytearray(data) + b'\x01'
    padded += bytes((-len(padded)) % 136)
    padded[-1] |= 128
    a = [0] * 25
    rol = lambda x,n: ((x << n) | (x >> ((64-n) % 64))) & MASK
    for off in range(0,len(padded),136):
        for i,v in enumerate(struct.unpack('<17Q', padded[off:off+136])): a[i] ^= v
        for rc in RC:
            c = [a[x]^a[x+5]^a[x+10]^a[x+15]^a[x+20] for x in range(5)]
            d = [c[(x-1)%5]^rol(c[(x+1)%5],1) for x in range(5)]
            a = [v^d[i%5] for i,v in enumerate(a)]
            b = [0]*25
            for y in range(5):
                for x in range(5): b[y+5*((2*x+3*y)%5)] = rol(a[x+5*y],ROT[x+5*y])
            a = [b[x+5*y]^((~b[(x+1)%5+5*y])&b[(x+2)%5+5*y]) for y in range(5) for x in range(5)]
            a[0] ^= rc
    return struct.pack('<25Q',*a)[:32]

# Test vector public key reconstruction from monero_tx_probe.c, using affine Edwards arithmetic.
P = 2**255-19
L = 2**252+27742317777372353535851937790883648493
D = -121665*pow(121666,-1,P)%P
BY = 4*pow(5,-1,P)%P
BX = pow((BY*BY-1)*pow(D*BY*BY+1,-1,P)%P,(P+3)//8,P)
if (BX*BX-(BY*BY-1)*pow(D*BY*BY+1,-1,P))%P: BX=BX*pow(2,(P-1)//4,P)%P
if BX%2: BX=P-BX
BASE = (BX,BY)
def add(a,b):
    x,y=a; u,v=b; z=D*x*u*y*v
    return ((x*v+u*y)*pow(1+z,-1,P)%P,(y*v+x*u)*pow(1-z,-1,P)%P)
def mul(p,n):
    r=(0,1)
    while n:
        if n&1: r=add(r,p)
        p=add(p,p); n>>=1
    return r
def pack(p): return (p[1]|((p[0]&1)<<255)).to_bytes(32,'little')
def unpack(b):
    n=int.from_bytes(b,'little'); y=n&((1<<255)-1); xx=(y*y-1)*pow(D*y*y+1,-1,P)%P
    x=pow(xx,(P+3)//8,P)
    if (x*x-xx)%P: x=x*pow(2,(P-1)//4,P)%P
    if x%2 != n>>255: x=P-x
    return x,y

def scalar(label,ctr):
    return int.from_bytes(keccak(label.encode()+b'KeepKey 7.17 Monero tx vectors'.ljust(32,b'\0')+struct.pack('<I',ctr)),'little')%L

def address(spend,view,sub=False):
    data=bytes([42 if sub else 18])+spend+view
    data+=keccak(data)[:4]
    alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    sizes=[0,2,3,5,6,7,9,10,11]
    out=''
    for i in range(0,len(data),8):
        block=data[i:i+8]; n=int.from_bytes(block,'big'); s=''
        while n: s=alphabet[n%58]+s; n//=58
        out+=s.rjust(sizes[len(block)],'1')
    return out

def payment_keys(name, data, own):
    # Public abandon-account0 fixture scalar from monero_core_vectors.h.
    spend = bytes.fromhex('8f2d521d4334f4d5d174c47aacb346e7633516416fae089d74ecfd0c389a6b08')
    change_index = next((j for j, d in enumerate(data.outputs)
                         if data.HasField('change_dts') and d.spend_public_key == own[:32]
                         and d.view_public_key == own[32:] and d.amount == data.change_dts.amount), 2)
    transcript = b'KKXMR-init-v1'.ljust(16, b'\0')
    transcript += struct.pack('<11I', 0x8000002c, 0x80000080, 0x80000000,
                              0, data.account, data.num_inputs, 16, 16, 4, change_index, 0)
    transcript += struct.pack('<3Q', data.fee, 0, data.change_dts.amount) + bytes(8)
    for d in data.outputs:
        transcript += struct.pack('<Q', d.amount) + d.spend_public_key + d.view_public_key + bytes([d.is_subaddress])
    transcript += own
    rng = keccak(b'KKXMR-test-rng-v1' + name.encode().ljust(32, b'\0') + bytes(4))
    master = keccak(b'KKXMR-K'.ljust(32, b'\0') + struct.pack('<I', 32) + spend + struct.pack('<I', 32) + keccak(transcript) + rng)
    def key(label, index):
        return (int.from_bytes(keccak(label.encode().ljust(16, b'\0') + master + struct.pack('<I', index)), 'little') % L).to_bytes(32, 'little')
    return key('KKXMR-r', 0), [key('KKXMR-ra', j) for j in range(2)]

class Reader:
    def __init__(self,data): self.data=data; self.pos=0
    def take(self,n):
        b=self.data[self.pos:self.pos+n]; self.pos+=n
        assert len(b)==n
        return b
    def num(self,n=1): return int.from_bytes(self.take(n),'little')
    def var(self):
        n=0; shift=0
        while True:
            b=self.num(); n|=(b&127)<<shift
            if b<128: return n
            shift+=7
    def vector(self): return self.take(self.var())

def main(records,proto,output=None):
    with tempfile.TemporaryDirectory() as tmp:
        descriptor=Path(tmp)/'schema.pb'
        subprocess.run(['protoc','-I',proto,'--descriptor_set_out='+str(descriptor),str(Path(proto)/'messages-monero.proto')],check=True)
        schema=descriptor_pb2.FileDescriptorSet.FromString(descriptor.read_bytes())
        pool=descriptor_pool.DescriptorPool()
        for file in schema.file: pool.Add(file)
        pb=SimpleNamespace(**{m.name:message_factory.GetMessageClass(pool.FindMessageTypeByName(m.name)) for file in schema.file for m in file.message_type})
    raw=Path(records).read_bytes(); r=Reader(raw); cases=[]
    while r.pos<len(raw):
        kind=r.take(1)
        if kind==b'A':
            r.take(1); r.take(r.num()); r.take(1); r.take(r.num()); r.take(74); continue
        assert kind==b'T'
        valid=r.num(); name=r.take(r.num()).decode(); tx=r.take(r.num(4)); prefix_hash=r.take(32); message=r.take(32); fee=r.num(8); count=r.num()
        rings=[]
        for _ in range(count):
            ring=[dict(globalIndex=str(r.num(8)),publicKey=r.take(32).hex(),commitment=r.take(32).hex()) for _ in range(16)]
            r.take(32) # omit the test one-time spend secret
            rings.append(ring)
        recipients=[dict(amount=r.num(8),viewSecret=r.take(32),spend=r.take(32)) for _ in range(2)]
        r.take(40) # payment-id metadata; not needed for these non-integrated fixtures
        selected = ('sweep-0-0','sweep-0-1','sweep-1-0','sweep-1-1') if output else ('1in-2out-standard','2in-2out-subaddress')
        if not valid or name not in selected: continue
        sweep = name.startswith('sweep-')
        if not sweep: assert keccak(tx).hex()=={'1in-2out-standard':'111b9c0c892a73bc30edf364c0e5a6d5299adcd5bc93ecb72f0dd1126d1470c0','2in-2out-subaddress':'4aa189518e5073ea5832547cfb435024ae198f8250259863538182e0d6ce259b'}[name]
        t=Reader(tx); assert t.var()==2 and t.var()==0 and t.var()==count
        vinis=[]
        for _ in range(count):
            start=t.pos; assert t.take(3)==bytes([2,0,16])
            for _ in range(16): t.var()
            t.take(32); vinis.append(tx[start:t.pos])
        assert t.var()==2
        outs=[t.take(35) for _ in range(2)]; extra=t.vector(); assert keccak(tx[:t.pos])==prefix_hash
        assert t.num()==6 and t.var()==fee
        ecdh=[t.take(8) for _ in range(2)]; commitments=[t.take(32) for _ in range(2)]
        assert t.var()==1
        proof=t.take(642); clsags=[t.take(576) for _ in range(count)]; pseudos=[t.take(32) for _ in range(count)]; assert t.pos==len(tx)
        change_index=1 if count==1 else 0
        own=recipients[change_index]
        if sweep:
            spend = bytes.fromhex('8f2d521d4334f4d5d174c47aacb346e7633516416fae089d74ecfd0c389a6b08')
            own = dict(spend=pack(mul(BASE,int.from_bytes(spend,'little'))),viewSecret=(int.from_bytes(keccak(spend),'little')%L).to_bytes(32,'little'))
        own_spend=unpack(own['spend'])
        # Restore plan order from ring global indices (tag 1; or tags 2,3).
        sorted_to_orig=[(int(ring[0]['globalIndex'])-1000000)//100000-1-(count==2) for ring in rings]
        inputs=[None]*count
        sources=[None]*count
        for sorted_idx,orig in enumerate(sorted_to_orig):
            tag=1 if count==1 else orig+2; minor=3 if count==2 and orig==0 else 0; additional=count==2 and orig==1
            dst=own_spend
            if minor:
                m=int.from_bytes(keccak(b'SubAddr\0'+own['viewSecret']+struct.pack('<II',0,minor)),'little')%L
                dst=add(dst,mul(BASE,m))
            R=mul(dst if minor else BASE,scalar('owned',tag*4))
            txpub=pack(mul(BASE,scalar('owned',tag*4+1))) if additional else pack(R)
            mask=scalar('owned',tag*4+2).to_bytes(32,'little')
            amount=2000000000000 if count==1 else (1500000000000 if orig==0 else 500000000000)
            real=5 if count==1 else (0 if orig==0 else 15)
            source=pb.MoneroTxSourceEntry(real_index=real,real_out_tx_key=txpub,real_output_in_tx_index=tag%3,amount=amount,mask=mask,sub_major=0,sub_minor=minor)
            for member in rings[sorted_idx]: source.ring.add(global_index=int(member['globalIndex']),dest=bytes.fromhex(member['publicKey']),commitment=bytes.fromhex(member['commitment']))
            if additional: source.real_out_additional_key=pack(R)
            sources[orig]=source
            inputs[orig]=dict(amountAtomic=str(amount),realMember=real,outputIndex=tag%3,subaddressMajor=0,subaddressMinor=minor,txPublicKey=txpub.hex(),mask=mask.hex(),additionalTxPublicKeys=[pack(R).hex()] if additional else [],ring=rings[sorted_idx])
        outputs=[]; destinations=[]
        for j,o in enumerate(recipients):
            sub=(name.startswith('sweep-1-') and o['amount'] > 0) if sweep else count==2 and j!=change_index
            view=pack(mul(unpack(o['spend']) if sub else BASE,int.from_bytes(o['viewSecret'],'little')))
            outputs.append(dict(amountAtomic=str(o['amount']),address=address(o['spend'],view,sub),isChange=not sweep and j==change_index,changeMajor=0,changeMinor=0))
            destinations.append(pb.MoneroTxDestination(amount=o['amount'],spend_public_key=o['spend'],view_public_key=view,is_subaddress=sub,is_integrated=False))
        change=destinations[change_index]
        data=pb.MoneroTxData(num_inputs=count,ring_size=16,fee=fee,account=0,unlock_time=0,hard_fork=16,bp_version=4)
        data.outputs.extend(destinations)
        if not sweep: data.change_dts.CopyFrom(pb.MoneroTxChange(amount=change.amount,spend_public_key=change.spend_public_key,view_public_key=change.view_public_key,major=0,minor=0))
        requests=[]; responses=[]
        emit=lambda m:m.SerializeToString().hex()
        def pair(id,req,res): requests.append(dict(id=id,hex=emit(req))); responses.append(dict(id=id+1,hex=emit(res)))
        macs=[hashlib.sha256(('test destination '+str(j)).encode()).digest() for j in range(2)]
        pair(1810,pb.MoneroTxInitRequest(address_n=[0x8000002c,0x80000080,0x80000000],network_type=0,tsx_data=data),pb.MoneroTxInitAck(dst_hmacs=macs,rsig_mode=0))
        acks=[]
        for orig in range(count):
            k=sorted_to_orig.index(orig)
            ack=pb.MoneroTxSetInputAck(vini=vinis[k],vini_hmac=hashlib.sha256(bytes([orig])).digest(),pseudo_out=bytes([orig+1])*32,pseudo_out_hmac=hashlib.sha256(bytes([orig,1])).digest())
            acks.append(ack); pair(1812,pb.MoneroTxSetInputRequest(src=sources[orig]),ack)
        for orig in sorted_to_orig: pair(1814,pb.MoneroTxInputViniRequest(vini=acks[orig].vini,vini_hmac=acks[orig].vini_hmac,orig_idx=orig),pb.MoneroTxInputViniAck())
        pair(1816,pb.MoneroTxAllInputsSetRequest(),pb.MoneroTxAllInputsSetAck())
        for j in range(2):
            ack=pb.MoneroTxSetOutputAck(tx_out=outs[j],out_pk=outs[j][2:34]+commitments[j],ecdh_info=ecdh[j])
            if j==1: ack.bp_plus=proof
            pair(1818,pb.MoneroTxSetOutputRequest(dst=destinations[j],dst_hmac=macs[j]),ack)
        pair(1820,pb.MoneroTxAllOutSetRequest(),pb.MoneroTxAllOutSetAck(extra=extra,tx_prefix_hash=prefix_hash,fee=fee,rct_type=6,full_message_hash=message))
        opening=hashlib.sha256(b'public stream fixture opening key').digest()
        for k,orig in enumerate(sorted_to_orig):
            a=acks[orig]
            pair(1822,pb.MoneroTxSignInputRequest(src=sources[orig],vini=a.vini,vini_hmac=a.vini_hmac,pseudo_out=a.pseudo_out,pseudo_out_hmac=a.pseudo_out_hmac,orig_idx=orig),pb.MoneroTxSignInputAck(clsag_enc=ChaCha20Poly1305(opening).encrypt(struct.pack('<I',k)+bytes(8),clsags[k],None),pseudo_out=pseudos[k]))
        own_keys = own['spend'] + pack(mul(BASE,int.from_bytes(own['viewSecret'],'little')))
        tx_key, additional = payment_keys(name, data, own_keys)
        nonchange = next(d for j,d in enumerate(destinations) if j != change_index)
        public_base = unpack(nonchange.spend_public_key) if not sweep and nonchange.is_subaddress else BASE
        assert pack(mul(public_base, int.from_bytes(tx_key, 'little'))) == extra[1:33]
        if extra[33:35] != bytes([4,2]): additional = []
        for j,key in enumerate(additional):
            base = unpack(destinations[j].spend_public_key) if destinations[j].is_subaddress else BASE
            assert pack(mul(base,int.from_bytes(key,'little'))) == extra[35+j*32:67+j*32]
        pair(1824,pb.MoneroTxFinalRequest(),pb.MoneroTxFinalAck(opening_key=opening,tx_key=tx_key,additional_tx_keys=additional))
        cases.append(dict(name=name,plan=dict(network=0,feeAtomic=str(fee),inputs=inputs,outputs=outputs),requests=requests,responses=responses,transactionHex=tx.hex(),prefixHash=prefix_hash.hex(),transactionKeccak=keccak(tx).hex()))
    out=Path(output) if output else Path(__file__).resolve().parents[1]/'src/bun/monero-stream.fixtures.json'
    out.write_text(json.dumps(dict(source='monero_tx.cpp; monero_tx_vectors.h; Core v0.18.5.4',recordsSha256=hashlib.sha256(raw).hexdigest(),envelopes='protoc encoding of public vector pieces; test MACs and re-sealed CLSAGs; not captured device messages',cases=cases),indent=2)+'\n')
    print(f'Wrote {len(cases)} Core-verified assembly fixtures')

if __name__=='__main__': main(*sys.argv[1:])
