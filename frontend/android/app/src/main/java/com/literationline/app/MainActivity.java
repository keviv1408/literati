package com.literationline.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.webkit.WebView;

import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends BridgeActivity {
    private static final Pattern ROOM_PATH = Pattern.compile("/room/([a-zA-Z0-9]{6})/?");

    private boolean firstPageVisible;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        bridgeBuilder.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageCommitVisible(WebView view, String url) {
                firstPageVisible = true;
            }
        });
        super.onCreate(savedInstanceState);
        // A WebView failure must still let Android show its error screen.
        long deadline = SystemClock.uptimeMillis() + 2500;
        splash.setKeepOnScreenCondition(() -> bridge != null && !firstPageVisible && SystemClock.uptimeMillis() < deadline);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Capacitor also calls this after constructing the WebView on a cold launch.
        if (bridge == null || intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri invite = intent.getData();
        if (invite == null || !invite.isHierarchical() || invite.getUserInfo() != null) return;
        String scheme = invite.getScheme();
        if (!"https".equals(scheme) && !"http".equals(scheme)) return;
        if (!getString(R.string.invite_host).equalsIgnoreCase(invite.getHost())) return;

        int defaultPort = "https".equals(scheme) ? 443 : 80;
        int configuredPort = getResources().getInteger(R.integer.invite_port);
        int invitePort = invite.getPort() == -1 ? defaultPort : invite.getPort();
        if (invitePort != (configuredPort == -1 ? defaultPort : configuredPort)) return;

        String path = invite.getEncodedPath();
        if (path == null) return;
        Matcher match = ROOM_PATH.matcher(path);
        if (!match.matches()) return;

        Uri.Builder destination = Uri.parse(bridge.getLocalUrl()).buildUpon().path("/")
            .appendQueryParameter("room", match.group(1).toUpperCase(Locale.ROOT));
        if ("1".equals(invite.getQueryParameter("spectate"))) {
            destination.appendQueryParameter("spectate", "1");
        }
        WebView webView = bridge.getWebView();
        String url = destination.toString();
        if (!url.equals(webView.getUrl())) webView.loadUrl(url);
    }
}
