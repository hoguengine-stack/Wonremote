package android.text;

// Used by FirebaseException's message validation in JVM tests, never packaged.
public final class TextUtils {
    private TextUtils() {}

    public static boolean isEmpty(CharSequence value) {
        return value == null || value.length() == 0;
    }
}
