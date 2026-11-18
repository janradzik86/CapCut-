package app.clipforge.editor;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Publishes a file from the app cache into shared storage so it appears in the Gallery / Files:
 *  video/*  -> Movies/ClipForge, image/* -> Pictures/ClipForge, other -> Download/ClipForge.
 * Android 10+ uses MediaStore (no permission needed); Android 6-9 writes the public folder and
 * asks for WRITE_EXTERNAL_STORAGE at runtime.
 */
@CapacitorPlugin(name = "MediaSaver", permissions = {
    @Permission(strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }, alias = "storage")
})
public class MediaSaverPlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        if (call.getString("path") == null || call.getString("name") == null) { call.reject("Brak ścieżki lub nazwy pliku"); return; }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storagePermissionCallback");
            return;
        }
        saveInBackground(call);
    }

    @PermissionCallback
    private void storagePermissionCallback(PluginCall call) {
        if (getPermissionState("storage") == PermissionState.GRANTED) saveInBackground(call);
        else call.reject("Brak zgody na zapis w pamięci urządzenia");
    }

    private void saveInBackground(PluginCall call) {
        new Thread(() -> {
            try { call.resolve(doSave(call.getString("path"), call.getString("name"), call.getString("mime", "video/mp4"))); }
            catch (Exception e) { call.reject("Zapis nie powiódł się: " + e.getMessage(), e); }
        }).start();
    }

    private JSObject doSave(String path, String name, String mime) throws Exception {
        File src = new File(Uri.parse(path).getPath());
        if (!src.exists()) throw new Exception("plik tymczasowy nie istnieje");
        String dir; Uri collection;
        if (mime.startsWith("video/")) { dir = Environment.DIRECTORY_MOVIES; collection = Build.VERSION.SDK_INT >= 29 ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY) : null; }
        else if (mime.startsWith("image/")) { dir = Environment.DIRECTORY_PICTURES; collection = Build.VERSION.SDK_INT >= 29 ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY) : null; }
        else { dir = Environment.DIRECTORY_DOWNLOADS; collection = Build.VERSION.SDK_INT >= 29 ? MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY) : null; }
        String rel = dir + "/ClipForge";
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver cr = getContext().getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, rel);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri item = cr.insert(collection, v);
            if (item == null) throw new Exception("MediaStore odrzucił plik");
            try (InputStream in = new FileInputStream(src); OutputStream out = cr.openOutputStream(item)) {
                if (out == null) throw new Exception("nie można otworzyć pliku docelowego");
                copy(in, out);
            } catch (Exception e) { cr.delete(item, null, null); throw e; }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(item, done, null, null);
            ret.put("uri", item.toString());
        } else {
            File outDir = new File(Environment.getExternalStoragePublicDirectory(dir), "ClipForge");
            if (!outDir.exists() && !outDir.mkdirs()) throw new Exception("nie można utworzyć folderu " + outDir);
            File out = unique(outDir, name);
            try (InputStream in = new FileInputStream(src); OutputStream os = new FileOutputStream(out)) { copy(in, os); }
            MediaScannerConnection.scanFile(getContext(), new String[] { out.getAbsolutePath() }, new String[] { mime }, null);
            ret.put("uri", Uri.fromFile(out).toString());
            name = out.getName();
        }
        ret.put("displayPath", rel + "/" + name);
        return ret;
    }

    private static File unique(File dir, String name) {
        File f = new File(dir, name); if (!f.exists()) return f;
        int dot = name.lastIndexOf('.'); String base = dot > 0 ? name.substring(0, dot) : name, ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 2; ; i++) { f = new File(dir, base + " (" + i + ")" + ext); if (!f.exists()) return f; }
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[1 << 16]; int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        out.flush();
    }
}
