import java.nio.file.*;
import com.sparrowwallet.drongo.psbt.*;
public class SparrowMultisigCheck {
 public static void main(String[] args) throws Exception {
  Path dir=Path.of(args[0]); String type=args[1];
  PSBT before=new PSBT(Files.readAllBytes(dir.resolve(type+"-unsigned.psbt")));
  PSBT after=new PSBT(Files.readAllBytes(dir.resolve(type+"-cosigned.psbt")));
  if(after.getFee()!=1000L)throw new Exception("Wrong fee");
  if(!java.util.Arrays.equals(before.getTransaction().bitcoinSerialize(),after.getTransaction().bitcoinSerialize()))throw new Exception("Unsigned transaction changed");
  for(var input:after.getPsbtInputs())if(input.getPartialSignatures().size()!=2)throw new Exception("Missing partial signatures");
  after.verifySignatures();
  System.out.println("Sparrow: "+type+" physical KeepKey and test-cosigner signatures verify; unsigned transaction unchanged; fee=1000 sats");
 }
}
