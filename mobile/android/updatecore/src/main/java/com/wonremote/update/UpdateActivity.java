package com.wonremote.update;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.ImageButton;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import java.io.File;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public abstract class UpdateActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private UpdateClient updater;
    private boolean checked, busy, resumed, waitingPermission;
    private Runnable pendingUi;
    private File downloadedApk;
    private AlertDialog dialog;
    private ImageButton updateButton;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        try {
            PackageInfo installed = getPackageManager().getPackageInfo(getPackageName(), 0);
            updater = new UpdateClient(getPackageName(), version(installed), UpdateClient::openHttps);
        } catch (PackageManager.NameNotFoundException error) { throw new IllegalStateException(error); }
    }
    public final ImageButton updateButton() {
        updateButton = new ImageButton(this);
        updateButton.setImageResource(android.R.drawable.ic_popup_sync);
        updateButton.setContentDescription("업데이트 확인");
        updateButton.setTooltipText("업데이트 확인");
        updateButton.setOnClickListener(view -> checkUpdate(true));
        return updateButton;
    }
    @Override protected void onPostResume() {
        super.onPostResume();
        resumed = true;
        if (waitingPermission) {
            waitingPermission = false;
            if (getPackageManager().canRequestPackageInstalls()) launchInstaller();
            else message("설치 권한 필요", "이 앱의 '알 수 없는 앱 설치'를 허용한 뒤 업데이트를 다시 눌러주세요.");
        }
        if (pendingUi != null) {
            Runnable action = pendingUi;
            pendingUi = null;
            action.run();
        }
        if (!checked) { checked = true; checkUpdate(false); }
    }
    @Override protected void onPause() { resumed = false; super.onPause(); }
    public final void checkUpdate(boolean manual) {
        if (busy || updater == null || (dialog != null && dialog.isShowing())) return;
        setBusy(true);
        worker.execute(() -> {
            try {
                UpdateClient.Release release = updater.check(manual);
                ui(() -> {
                    setBusy(false);
                    if (release != null) {
                        dialog = new AlertDialog.Builder(this).setTitle("업데이트")
                            .setMessage("최신 버전 " + release.versionName + "이 있습니다. 확인을 누르면 업데이트를 진행합니다.")
                            .setPositiveButton("확인", (d, which) -> download(release)).show();
                    } else if (manual) message("업데이트", "현재 최신 버전입니다.");
                });
            } catch (Exception error) { failure(error); }
        });
    }
    private void download(UpdateClient.Release release) {
        setBusy(true);
        Toast.makeText(this, "업데이트 다운로드 중", Toast.LENGTH_LONG).show();
        worker.execute(() -> {
            File apk = new File(getCacheDir(), "updates/update.apk");
            try {
                updater.download(release, apk);
                PackageManager manager = getPackageManager();
                PackageInfo incoming = manager.getPackageArchiveInfo(apk.getPath(), PackageManager.GET_SIGNATURES);
                PackageInfo installed = manager.getPackageInfo(getPackageName(), PackageManager.GET_SIGNATURES);
                if (incoming == null || !getPackageName().equals(incoming.packageName)
                    || version(incoming) != release.versionCode || version(incoming) <= version(installed)
                    || !signatures(incoming).equals(signatures(installed)) || signatures(incoming).isEmpty()) {
                    throw new java.io.IOException("APK package, version or signer mismatch");
                }
                ui(() -> {
                    setBusy(false);
                    downloadedApk = apk;
                    if (manager.canRequestPackageInstalls()) launchInstaller();
                    else {
                        dialog = new AlertDialog.Builder(this).setTitle("업데이트 설치 권한")
                            .setMessage("설정에서 이 앱의 '알 수 없는 앱 설치'를 허용하면 업데이트 설치를 이어갑니다.")
                            .setPositiveButton("설정", (d, which) -> {
                                waitingPermission = true;
                                try { startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    Uri.parse("package:" + getPackageName()))); }
                                catch (RuntimeException error) { waitingPermission = false; failure(error); }
                            }).show();
                    }
                });
            } catch (Exception error) { apk.delete(); failure(error); }
        });
    }
    private void launchInstaller() {
        if (downloadedApk == null || !downloadedApk.isFile()) {
            message("업데이트", "설치 파일이 없습니다. 업데이트를 다시 확인해주세요.");
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".updates", downloadedApk);
            Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(intent);
        } catch (RuntimeException error) { failure(error); }
    }
    private static long version(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }
    private static Set<String> signatures(PackageInfo info) {
        Set<String> result = new HashSet<>();
        if (info.signatures != null) for (android.content.pm.Signature signature : info.signatures)
            result.add(signature.toCharsString());
        return result;
    }
    private void setBusy(boolean value) {
        busy = value;
        if (updateButton != null) updateButton.setEnabled(!value);
    }
    private void failure(Exception error) {
        android.util.Log.w("WonRemoteUpdate", "APK update failed", error);
        ui(() -> {
            setBusy(false);
            message("업데이트 실패", "업데이트를 완료하지 못했습니다. 네트워크를 확인하고 업데이트 버튼으로 다시 시도해주세요.");
        });
    }
    private void message(String title, String text) {
        dialog = new AlertDialog.Builder(this).setTitle(title).setMessage(text).setPositiveButton("확인", null).show();
    }
    private void ui(Runnable action) {
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) return;
            if (resumed) action.run(); else pendingUi = action;
        });
    }
    @Override protected void onDestroy() {
        if (updater != null) updater.close();
        worker.shutdownNow();
        pendingUi = null;
        if (dialog != null) dialog.dismiss();
        super.onDestroy();
    }
}
