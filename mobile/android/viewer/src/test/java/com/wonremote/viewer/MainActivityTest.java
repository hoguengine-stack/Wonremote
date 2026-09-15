package com.wonremote.viewer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertSame;

import android.graphics.Insets;
import android.view.WindowInsets;
import android.widget.FrameLayout;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 35)
public final class MainActivityTest {
    @Test
    public void systemBarsAndCutoutPadContentWithoutImeHeight() {
        FrameLayout root = new FrameLayout(RuntimeEnvironment.getApplication());
        WindowInsets insets = new WindowInsets.Builder()
            .setInsets(WindowInsets.Type.statusBars(), Insets.of(0, 48, 0, 0))
            .setInsets(WindowInsets.Type.navigationBars(), Insets.of(0, 0, 0, 32))
            .setInsets(WindowInsets.Type.displayCutout(), Insets.of(12, 24, 10, 0))
            .setInsets(WindowInsets.Type.ime(), Insets.of(0, 0, 0, 420))
            .build();

        WindowInsets propagated = MainActivity.applySystemBarInsets(root, insets);

        assertEquals(12, root.getPaddingLeft());
        assertEquals(48, root.getPaddingTop());
        assertEquals(10, root.getPaddingRight());
        assertEquals(32, root.getPaddingBottom());
        assertSame(insets, propagated);
    }

    @Test
    public void requiresSecondBackPressInTheSameScopeWithinTwoSeconds() {
        assertEquals(true, MainActivity.isSecondBackPress("session", "session", 2000L));
        assertEquals(false, MainActivity.isSecondBackPress("session", "session", 2001L));
        assertEquals(false, MainActivity.isSecondBackPress("list", "session", 100L));
    }
}
