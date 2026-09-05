package android.util;

import java.util.HashMap;
import java.util.Map;

// Firebase's status-code enum uses this Android container during JVM unit tests.
public final class SparseArray<E> {
    private final Map<Integer, E> values = new HashMap<>();

    public E get(int key) {
        return values.get(key);
    }

    public void put(int key, E value) {
        values.put(key, value);
    }
}
