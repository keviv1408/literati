package com.literationline.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.SystemClock;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class RoomInviteTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    private Intent _invite(String path) {
        String host = context.getString(R.string.invite_host);
        int port = context.getResources().getInteger(R.integer.invite_port);
        String authority = port == -1 ? host : host + ":" + port;
        return new Intent(Intent.ACTION_VIEW, Uri.parse("https://" + authority + path))
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .setPackage(context.getPackageName())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    private void _awaitRoute(ActivityScenario<MainActivity> scenario, String query) {
        AtomicReference<String> url = new AtomicReference<>();
        long deadline = SystemClock.elapsedRealtime() + 10000;
        do {
            scenario.onActivity(activity -> url.set(activity.getBridge().getWebView().getUrl()));
            if (("https://localhost/?" + query).equals(url.get())) return;
            SystemClock.sleep(50);
        } while (SystemClock.elapsedRealtime() < deadline);
        assertEquals("https://localhost/?" + query, url.get());
    }

    @Test
    public void opensRoomOnColdLaunchAndHandlesAnotherInviteWhileRunning() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(_invite("/room/ab12cD"))) {
            _awaitRoute(scenario, "room=AB12CD");
            context.startActivity(_invite("/room/ef34gh/?spectate=1"));
            _awaitRoute(scenario, "room=EF34GH&spectate=1");
        }
    }

    @Test
    public void leavesUnrelatedWebLinksToTheBrowser() {
        assertNull(_invite("/tutorial").resolveActivity(context.getPackageManager()));
        assertNull(_invite("/spectate/private-token").resolveActivity(context.getPackageManager()));
        assertNull(_invite("/room/ABC123/extra").resolveActivity(context.getPackageManager()));
    }
}
