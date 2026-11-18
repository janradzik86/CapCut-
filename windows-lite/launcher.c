/* ClipForge for Windows — launcher + local app server.
 *
 * Serves the bundled app (app\) on http://127.0.0.1:47816 and opens it in an app window of
 * Microsoft Edge (built into Windows 10/11) or Google Chrome with a dedicated profile.
 * Serving over HTTP (instead of file://) is required for ES modules, WebAssembly and AI model
 * loading; COOP/COEP headers enable multi-threaded WebAssembly for the AI engines.
 *
 * API (only for the app itself: Host must be 127.0.0.1:<port> and X-ClipForge: 1 is required):
 *   POST /api/save?name=<utf8>&mime=<type>  body = file  -> saved to Videos|Pictures|Documents\ClipForge
 *   GET  /api/reveal?path=<utf8>                         -> opens Explorer with the file selected
 *   GET  /api/ping                                       -> "clipforge"
 */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shlobj.h>
#include <knownfolders.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define BASE_PORT 47816
static wchar_t g_root[MAX_PATH];
static int g_port = 0;
static char g_host[64];

/* ---------------------------------------------------------------- utils */
static int fileExists(const wchar_t *p) { DWORD a = GetFileAttributesW(p); return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY); }

static int sendAll(SOCKET s, const char *buf, int len) {
    while (len > 0) { int n = send(s, buf, len, 0); if (n <= 0) return 0; buf += n; len -= n; }
    return 1;
}
static void sendStatus(SOCKET s, int code, const char *text, const char *ctype, const char *body) {
    char h[512]; int bl = body ? (int)strlen(body) : 0;
    int n = snprintf(h, sizeof h, "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nCache-Control: no-store\r\n"
                     "Cross-Origin-Resource-Policy: same-origin\r\nConnection: close\r\n\r\n", code, text, ctype, bl);
    sendAll(s, h, n); if (bl) sendAll(s, body, bl);
}
static int hexv(char c) { if (c >= '0' && c <= '9') return c - '0'; if (c >= 'a' && c <= 'f') return c - 'a' + 10; if (c >= 'A' && c <= 'F') return c - 'A' + 10; return -1; }
static void urlDecode(const char *in, char *out, size_t cap, int plusSpace) {
    size_t o = 0;
    for (; *in && o + 1 < cap; in++) {
        if (*in == '%' && hexv(in[1]) >= 0 && hexv(in[2]) >= 0) { out[o++] = (char)(hexv(in[1]) * 16 + hexv(in[2])); in += 2; }
        else if (*in == '+' && plusSpace) out[o++] = ' ';
        else out[o++] = *in;
    }
    out[o] = 0;
}
static int queryParam(const char *query, const char *key, char *out, size_t cap) {
    size_t kl = strlen(key); const char *p = query;
    while (p && *p) {
        if (!strncmp(p, key, kl) && p[kl] == '=') {
            const char *v = p + kl + 1; const char *e = strchr(v, '&'); size_t n = e ? (size_t)(e - v) : strlen(v);
            char tmp[2048]; if (n >= sizeof tmp) n = sizeof tmp - 1; memcpy(tmp, v, n); tmp[n] = 0; urlDecode(tmp, out, cap, 1); return 1;
        }
        p = strchr(p, '&'); if (p) p++;
    }
    return 0;
}
static void utf8ToW(const char *s, wchar_t *w, int cap) { if (!MultiByteToWideChar(CP_UTF8, 0, s, -1, w, cap)) w[0] = 0; }
static void wToUtf8(const wchar_t *w, char *s, int cap) { if (!WideCharToMultiByte(CP_UTF8, 0, w, -1, s, cap, NULL, NULL)) s[0] = 0; }

static const char *mimeFor(const wchar_t *p) {
    const wchar_t *e = wcsrchr(p, L'.'); if (!e) return "application/octet-stream";
    static const struct { const wchar_t *ext; const char *mime; } T[] = {
        {L".html", "text/html; charset=utf-8"}, {L".js", "text/javascript; charset=utf-8"}, {L".mjs", "text/javascript; charset=utf-8"},
        {L".css", "text/css; charset=utf-8"}, {L".json", "application/json"}, {L".wasm", "application/wasm"}, {L".svg", "image/svg+xml"},
        {L".png", "image/png"}, {L".jpg", "image/jpeg"}, {L".ico", "image/x-icon"}, {L".onnx", "application/octet-stream"},
        {L".tflite", "application/octet-stream"}, {L".task", "application/octet-stream"}, {L".txt", "text/plain; charset=utf-8"},
        {L".webm", "video/webm"}, {L".mp4", "video/mp4"}, {L".mp3", "audio/mpeg"}, {L".ogg", "audio/ogg"} };
    for (size_t i = 0; i < sizeof T / sizeof T[0]; i++) if (!_wcsicmp(e, T[i].ext)) return T[i].mime;
    return "application/octet-stream";
}

/* ------------------------------------------------------------ handlers */
static void serveFile(SOCKET s, const char *urlPath, int headOnly) {
    char dec[1024]; urlDecode(urlPath, dec, sizeof dec, 0);
    if (strstr(dec, "..") || strchr(dec, ':') || strchr(dec, '\\')) { sendStatus(s, 403, "Forbidden", "text/plain", "forbidden"); return; }
    if (!strcmp(dec, "/")) strcpy(dec, "/index.html");
    wchar_t rel[1024], full[MAX_PATH * 2]; utf8ToW(dec, rel, 1024);
    for (wchar_t *c = rel; *c; c++) if (*c == L'/') *c = L'\\';
    swprintf(full, MAX_PATH * 2, L"%ls%ls", g_root, rel);
    HANDLE f = CreateFileW(full, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, NULL);
    if (f == INVALID_HANDLE_VALUE) { sendStatus(s, 404, "Not Found", "text/plain", "not found"); return; }
    LARGE_INTEGER sz; GetFileSizeEx(f, &sz);
    char h[768];
    int n = snprintf(h, sizeof h, "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %lld\r\nCache-Control: no-cache\r\n"
                     "Cross-Origin-Opener-Policy: same-origin\r\nCross-Origin-Embedder-Policy: require-corp\r\n"
                     "Cross-Origin-Resource-Policy: same-origin\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
                     mimeFor(full), (long long)sz.QuadPart);
    if (sendAll(s, h, n) && !headOnly) {
        enum { BUFSZ = 1 << 16 }; char *buf = (char *)malloc(BUFSZ); DWORD rd;
        if (buf) { while (ReadFile(f, buf, BUFSZ, &rd, NULL) && rd > 0) if (!sendAll(s, buf, (int)rd)) break; free(buf); }
    }
    CloseHandle(f);
}

static int knownDir(const char *mime, wchar_t *out) {
    const GUID *id = !strncmp(mime, "video/", 6) ? &FOLDERID_Videos : !strncmp(mime, "image/", 6) ? &FOLDERID_Pictures : &FOLDERID_Documents;
    PWSTR p = NULL; if (SHGetKnownFolderPath(id, 0, NULL, &p) != S_OK) return 0;
    swprintf(out, MAX_PATH, L"%ls\\ClipForge", p); CoTaskMemFree(p);
    SHCreateDirectoryExW(NULL, out, NULL); return 1;
}
static void jsonEscape(const char *in, char *out, size_t cap) {
    size_t o = 0; for (; *in && o + 3 < cap; in++) { if (*in == '\\' || *in == '"') out[o++] = '\\'; out[o++] = *in; } out[o] = 0;
}

static void handleSave(SOCKET s, const char *query, long long clen, const char *pre, int preLen) {
    char name[1024] = "", mime[128] = "application/octet-stream";
    queryParam(query, "name", name, sizeof name); queryParam(query, "mime", mime, sizeof mime);
    if (!name[0] || clen < 0) { sendStatus(s, 400, "Bad Request", "text/plain", "missing name/length"); return; }
    wchar_t wname[512], dir[MAX_PATH], path[MAX_PATH * 2]; utf8ToW(name, wname, 512);
    for (wchar_t *c = wname; *c; c++) if (wcschr(L"\\/:*?\"<>|", *c) || *c < 32) *c = L'_';
    if (!knownDir(mime, dir)) { sendStatus(s, 500, "Error", "text/plain", "no folder"); return; }
    swprintf(path, MAX_PATH * 2, L"%ls\\%ls", dir, wname);
    if (fileExists(path)) {   /* never overwrite: "name (2).mp4" */
        wchar_t base[512], *dot; wcscpy(base, wname); dot = wcsrchr(base, L'.'); wchar_t ext[32] = L"";
        if (dot) { wcsncpy(ext, dot, 31); *dot = 0; }
        for (int i = 2; i < 10000; i++) { swprintf(path, MAX_PATH * 2, L"%ls\\%ls (%d)%ls", dir, base, i, ext); if (!fileExists(path)) break; }
    }
    wchar_t tmp[MAX_PATH * 2]; swprintf(tmp, MAX_PATH * 2, L"%ls.part", path);
    HANDLE f = CreateFileW(tmp, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) { sendStatus(s, 500, "Error", "text/plain", "cannot create file"); return; }
    long long left = clen; DWORD wr; int ok = 1;
    if (preLen > 0) { int k = (int)(preLen > left ? left : preLen); ok = WriteFile(f, pre, k, &wr, NULL) && wr == (DWORD)k; left -= k; }
    enum { BUFSZ = 1 << 16 }; char *buf = (char *)malloc(BUFSZ); if (!buf) ok = 0;
    while (ok && left > 0) { int n = recv(s, buf, (int)(left > (long long)BUFSZ ? BUFSZ : left), 0); if (n <= 0) { ok = 0; break; }
        ok = WriteFile(f, buf, n, &wr, NULL) && wr == (DWORD)n; left -= n; }
    free(buf); CloseHandle(f);
    if (!ok || !MoveFileExW(tmp, path, MOVEFILE_REPLACE_EXISTING)) { DeleteFileW(tmp); sendStatus(s, 500, "Error", "text/plain", "write failed"); return; }
    char u8[MAX_PATH * 4], esc[MAX_PATH * 8], body[MAX_PATH * 8 + 32]; wToUtf8(path, u8, sizeof u8); jsonEscape(u8, esc, sizeof esc);
    snprintf(body, sizeof body, "{\"path\":\"%s\"}", esc); sendStatus(s, 200, "OK", "application/json", body);
}

static void handleReveal(SOCKET s, const char *query) {
    char p8[2048] = ""; queryParam(query, "path", p8, sizeof p8);
    wchar_t p[MAX_PATH * 2], d1[MAX_PATH], d2[MAX_PATH], d3[MAX_PATH]; utf8ToW(p8, p, MAX_PATH * 2);
    knownDir("video/", d1); knownDir("image/", d2); knownDir("text/", d3);
    if (!fileExists(p) || (_wcsnicmp(p, d1, wcslen(d1)) && _wcsnicmp(p, d2, wcslen(d2)) && _wcsnicmp(p, d3, wcslen(d3)))) {
        sendStatus(s, 404, "Not Found", "text/plain", "no"); return; }
    wchar_t args[MAX_PATH * 3]; swprintf(args, MAX_PATH * 3, L"/select,\"%ls\"", p);
    ShellExecuteW(NULL, L"open", L"explorer.exe", args, NULL, SW_SHOWNORMAL);
    sendStatus(s, 200, "OK", "application/json", "{\"ok\":true}");
}

static DWORD WINAPI client(LPVOID arg) {
    SOCKET s = (SOCKET)(UINT_PTR)arg; CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    char req[16384]; int len = 0; char *end = NULL;
    while (len < (int)sizeof req - 1) {
        int n = recv(s, req + len, sizeof req - 1 - len, 0); if (n <= 0) break; len += n; req[len] = 0;
        if ((end = strstr(req, "\r\n\r\n"))) break;
    }
    if (!end) { closesocket(s); CoUninitialize(); return 0; }
    *end = 0; const char *body = end + 4; int preLen = len - (int)(body - req);
    char method[8] = "", target[4096] = ""; sscanf(req, "%7s %4095s", method, target);
    /* headers */
    char host[128] = ""; long long clen = -1; int appHeader = 0;
    for (char *line = strstr(req, "\r\n"); line; line = strstr(line + 2, "\r\n")) {
        char *h = line + 2;
        if (!_strnicmp(h, "Host:", 5)) { sscanf(h + 5, " %127[^\r\n]", host); }
        else if (!_strnicmp(h, "Content-Length:", 15)) clen = _atoi64(h + 15);
        else if (!_strnicmp(h, "X-ClipForge:", 12)) appHeader = 1;
    }
    char *q = strchr(target, '?'); const char *query = ""; if (q) { *q = 0; query = q + 1; }
    if (_stricmp(host, g_host)) sendStatus(s, 403, "Forbidden", "text/plain", "bad host");          /* DNS-rebinding guard */
    else if (!strcmp(target, "/api/ping")) sendStatus(s, 200, "OK", "text/plain", "clipforge");
    else if (!strncmp(target, "/api/", 5) && !appHeader) sendStatus(s, 403, "Forbidden", "text/plain", "app only");
    else if (!strcmp(target, "/api/save") && !strcmp(method, "POST")) handleSave(s, query, clen, body, preLen);
    else if (!strcmp(target, "/api/reveal")) handleReveal(s, query);
    else if (!strcmp(method, "GET") || !strcmp(method, "HEAD")) serveFile(s, target, !strcmp(method, "HEAD"));
    else sendStatus(s, 405, "Method Not Allowed", "text/plain", "method");
    shutdown(s, SD_SEND); closesocket(s); CoUninitialize(); return 0;
}

static DWORD WINAPI serverLoop(LPVOID arg) {
    SOCKET ls = (SOCKET)(UINT_PTR)arg;
    for (;;) { SOCKET c = accept(ls, NULL, NULL); if (c == INVALID_SOCKET) continue;
        HANDLE th = CreateThread(NULL, 256 * 1024, client, (LPVOID)(UINT_PTR)c, 0, NULL); if (th) CloseHandle(th); else closesocket(c); }
    return 0;
}

/* is our own server already running on this port (second launch)? */
static int pingExisting(int port) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); if (s == INVALID_SOCKET) return 0;
    struct sockaddr_in a = {0}; a.sin_family = AF_INET; a.sin_port = htons((u_short)port); a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    DWORD to = 1500; setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (char *)&to, sizeof to);
    int ok = 0;
    if (!connect(s, (struct sockaddr *)&a, sizeof a)) {
        char r[256]; int n = snprintf(r, sizeof r, "GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nConnection: close\r\n\r\n", port);
        send(s, r, n, 0); char buf[512] = ""; int got = 0, k; while ((k = recv(s, buf + got, sizeof buf - 1 - got, 0)) > 0) got += k; buf[got] = 0;
        ok = strstr(buf, "clipforge") != NULL;
    }
    closesocket(s); return ok;
}

/* ------------------------------------------------------------ browser */
static int appPath(const wchar_t *exe, wchar_t *out, DWORD n) {
    wchar_t key[256]; HKEY roots[2] = { HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER };
    swprintf(key, 256, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\%ls", exe);
    for (int i = 0; i < 2; i++) { DWORD sz = n * sizeof(wchar_t);
        if (RegGetValueW(roots[i], key, NULL, RRF_RT_REG_SZ, NULL, out, &sz) == ERROR_SUCCESS && fileExists(out)) return 1; }
    return 0;
}
static int findBrowser(wchar_t *out, DWORD n) {
    if (appPath(L"msedge.exe", out, n)) return 1;
    const wchar_t *envs[3] = { L"ProgramFiles(x86)", L"ProgramFiles", L"LOCALAPPDATA" };
    const wchar_t *rel[2] = { L"\\Microsoft\\Edge\\Application\\msedge.exe", L"\\Google\\Chrome\\Application\\chrome.exe" };
    for (int r = 0; r < 2; r++) for (int i = 0; i < 3; i++) { wchar_t base[MAX_PATH];
        if (GetEnvironmentVariableW(envs[i], base, MAX_PATH)) { swprintf(out, n, L"%ls%ls", base, rel[r]); if (fileExists(out)) return 1; } }
    return appPath(L"chrome.exe", out, n);
}

int WINAPI wWinMain(HINSTANCE h, HINSTANCE p, PWSTR cmd, int show) {
    (void)h; (void)p; (void)show;
    int serveOnly = cmd && wcsstr(cmd, L"--serve-only") != NULL;   /* used for automated tests */
    wchar_t dir[MAX_PATH]; GetModuleFileNameW(NULL, dir, MAX_PATH); wchar_t *sl = wcsrchr(dir, L'\\'); if (sl) *sl = 0;
    swprintf(g_root, MAX_PATH, L"%ls\\app", dir);
    wchar_t idx[MAX_PATH]; swprintf(idx, MAX_PATH, L"%ls\\index.html", g_root);
    if (!fileExists(idx)) { MessageBoxW(NULL, L"Brak plików aplikacji (app\\index.html). Zainstaluj ponownie ClipForge.", L"ClipForge", MB_ICONERROR); return 1; }

    WSADATA wsa; if (WSAStartup(MAKEWORD(2, 2), &wsa)) { MessageBoxW(NULL, L"Nie można uruchomić sieci (Winsock).", L"ClipForge", MB_ICONERROR); return 1; }
    SOCKET ls = INVALID_SOCKET; int reuse = 0;
    for (int port = BASE_PORT; port < BASE_PORT + 12; port++) {
        if (pingExisting(port)) { g_port = port; reuse = 1; break; }
        SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); BOOL excl = TRUE;
        setsockopt(s, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (char *)&excl, sizeof excl);
        struct sockaddr_in a = {0}; a.sin_family = AF_INET; a.sin_port = htons((u_short)port); a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (!bind(s, (struct sockaddr *)&a, sizeof a) && !listen(s, 64)) { ls = s; g_port = port; break; }
        closesocket(s);
    }
    if (!g_port) { MessageBoxW(NULL, L"Nie można uruchomić lokalnego serwera aplikacji (porty 47816-47827 zajęte).", L"ClipForge", MB_ICONERROR); return 1; }
    snprintf(g_host, sizeof g_host, "127.0.0.1:%d", g_port);
    if (!reuse) { HANDLE th = CreateThread(NULL, 0, serverLoop, (LPVOID)(UINT_PTR)ls, 0, NULL); if (th) CloseHandle(th); }
    if (serveOnly) { Sleep(INFINITE); return 0; }

    wchar_t url[64]; swprintf(url, 64, L"http://127.0.0.1:%d/", g_port);
    wchar_t browser[MAX_PATH], data[MAX_PATH], args[MAX_PATH * 6];
    if (!findBrowser(browser, MAX_PATH)) {
        ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL);
        if (!reuse) { MessageBoxW(NULL, L"ClipForge działa w przeglądarce. Zamknij to okno, aby zakończyć program.", L"ClipForge", MB_ICONINFORMATION); }
        return 0;
    }
    if (SHGetFolderPathW(NULL, CSIDL_LOCAL_APPDATA, NULL, 0, data) != S_OK) GetTempPathW(MAX_PATH, data);
    wcscat(data, L"\\ClipForge\\profile"); SHCreateDirectoryExW(NULL, data, NULL);
    swprintf(args, MAX_PATH * 6,
        L"\"%ls\" --app=%ls --user-data-dir=\"%ls\" --no-first-run --no-default-browser-check "
        L"--autoplay-policy=no-user-gesture-required --window-size=1360,860 --disable-features=Translate",
        browser, url, data);
    STARTUPINFOW si = { sizeof(si) }; PROCESS_INFORMATION pi;
    if (!CreateProcessW(browser, args, NULL, NULL, FALSE, 0, NULL, dir, &si, &pi)) { ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL); return 0; }
    CloseHandle(pi.hThread);
    if (reuse) { CloseHandle(pi.hProcess); return 0; }
    /* keep serving while the app window (browser process for our profile) is open */
    WaitForSingleObject(pi.hProcess, INFINITE); CloseHandle(pi.hProcess);
    /* the browser may hand over to a still-running instance of the same profile: keep serving until it is gone */
    for (;;) {
        Sleep(3000);
        HANDLE lock; wchar_t lf[MAX_PATH]; swprintf(lf, MAX_PATH, L"%ls\\lockfile", data);
        lock = CreateFileW(lf, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
        if (lock != INVALID_HANDLE_VALUE || GetLastError() == ERROR_FILE_NOT_FOUND) { if (lock != INVALID_HANDLE_VALUE) CloseHandle(lock); break; }
    }
    return 0;
}
