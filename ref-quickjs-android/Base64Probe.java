import java.util.Base64;

public class Base64Probe {
    public static void main(String[] args) {
        String[] cases = {
            "aGVsbG8gd29ybGQ=",            // plain
            "\uFEFFaGVsbG8gd29ybGQ=",       // BOM prefix
            "aGVsbG8gd29ybGQ=\n",           // trailing newline
            "aGVs\nbG8g\nd29ybGQ=",         // embedded newlines
            "  aGVsbG8gd29ybGQ=  ",         // spaces
            "aGVsbG8gd29ybGQ",              // missing pad
        };
        for (String s : cases) {
            String label = s.replace("\uFEFF", "<BOM>").replace("\n", "<LF>");
            // getDecoder: strict
            String strict;
            try {
                byte[] b = Base64.getDecoder().decode(s);
                strict = "ok len=" + b.length;
            } catch (Exception e) {
                strict = e.getClass().getSimpleName();
            }
            // getMimeDecoder: lenient
            String mime;
            try {
                byte[] b = Base64.getMimeDecoder().decode(s);
                mime = "ok len=" + b.length;
            } catch (Exception e) {
                mime = e.getClass().getSimpleName();
            }
            System.out.printf("%-24s strict=%-22s mime=%s%n", label, strict, mime);
        }
    }
}
