import java.nio.file.*;
import java.util.*;
import com.google.gson.*;
import com.sparrowwallet.drongo.ExtendedKey;
import com.sparrowwallet.drongo.crypto.*;
import com.sparrowwallet.drongo.protocol.ScriptType;
import com.sparrowwallet.drongo.psbt.PSBT;

/** Companion to test-btc-sparrow.ts, using the installed Sparrow's real classes. */
public class SparrowPsbtCheck {
    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]);
        JsonArray fixtures = JsonParser.parseString(Files.readString(root.resolve("fixtures.json"))).getAsJsonArray();
        for (JsonElement entry : fixtures) {
            JsonObject f = entry.getAsJsonObject();
            String name = f.get("name").getAsString();
            var key = ExtendedKey.fromDescriptor(f.get("xpub").getAsString()).getKey();
            for (int i = 0; i < 5; i++) {
                var child = HDKeyDerivation.deriveChildKey(HDKeyDerivation.deriveChildKey(key, new ChildNumber(0)), new ChildNumber(i));
                String address = ScriptType.P2TR.getAddress(child).toString();
                if (!address.equals(f.getAsJsonArray("addresses").get(i).getAsString())) throw new Exception(name + ": address mismatch " + i);
            }
            PSBT signed = new PSBT(Files.readAllBytes(root.resolve(name + "-signed.psbt")));
            if (!signed.isFinalized()) throw new Exception(name + ": Desktop PSBT not finalized");
            if (!signed.extractTransaction().getTxId().toString().equals(f.get("txid").getAsString())) throw new Exception(name + ": txid mismatch");
            if (signed.getFee() != 1000L) throw new Exception(name + ": fee mismatch");
            PSBT unsigned = new PSBT(Files.readAllBytes(root.resolve(name + "-unsigned.psbt")));
            for (var input : unsigned.getPsbtInputs()) {
                if (input.getScriptType() != ScriptType.P2TR || input.getTapInternalKey() == null || input.getTapDerivedPublicKeys().isEmpty()) throw new Exception(name + ": missing BIP371 metadata");
            }
            Files.write(root.resolve(name + "-sparrow-unsigned.psbt"), unsigned.serialize());
            for (int i = 0; i < unsigned.getPsbtInputs().size(); i++) {
                ECKey signing = ECKey.fromPrivate(HexFormat.of().parseHex(f.getAsJsonArray("privateKeys").get(i).getAsString())).getTweakedOutputKey();
                if (!unsigned.getPsbtInputs().get(i).sign(signing)) throw new Exception(name + ": Sparrow did not sign");
            }
            unsigned.verifySignatures();
            Files.write(root.resolve(name + "-sparrow-signed.psbt"), unsigned.serialize());
            System.out.println(name + ": Sparrow accepted five addresses, BIP371 origins, signed PSBT, txid and fee; independent Schnorr signing passed");
        }
    }
}
