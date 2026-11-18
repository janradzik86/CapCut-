/* ClipForge launcher: opens the bundled web editor in an app window of
   Microsoft Edge (built into Windows 10/11) or Google Chrome. */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <shlobj.h>
#include <wchar.h>

static int exists(const wchar_t *p) { DWORD a = GetFileAttributesW(p); return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY); }

static int appPath(const wchar_t *exe, wchar_t *out, DWORD n) {
    wchar_t key[256]; HKEY roots[2] = { HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER };
    swprintf(key, 256, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\%ls", exe);
    for (int i = 0; i < 2; i++) { DWORD sz = n * sizeof(wchar_t);
        if (RegGetValueW(roots[i], key, NULL, RRF_RT_REG_SZ, NULL, out, &sz) == ERROR_SUCCESS && exists(out)) return 1; }
    return 0;
}

static int findBrowser(wchar_t *out, DWORD n) {
    if (appPath(L"msedge.exe", out, n)) return 1;
    const wchar_t *envs[3] = { L"ProgramFiles(x86)", L"ProgramFiles", L"LOCALAPPDATA" };
    const wchar_t *rel[2] = { L"\\Microsoft\\Edge\\Application\\msedge.exe", L"\\Google\\Chrome\\Application\\chrome.exe" };
    for (int r = 0; r < 2; r++) for (int i = 0; i < 3; i++) { wchar_t base[MAX_PATH];
        if (GetEnvironmentVariableW(envs[i], base, MAX_PATH)) { swprintf(out, n, L"%ls%ls", base, rel[r]); if (exists(out)) return 1; } }
    return appPath(L"chrome.exe", out, n);
}

int WINAPI wWinMain(HINSTANCE h, HINSTANCE p, PWSTR cmd, int show) {
    wchar_t dir[MAX_PATH], index[MAX_PATH * 3], url[MAX_PATH * 3], browser[MAX_PATH], data[MAX_PATH], args[MAX_PATH * 8];
    GetModuleFileNameW(NULL, dir, MAX_PATH);
    wchar_t *s = wcsrchr(dir, L'\\'); if (s) *s = 0;
    swprintf(index, MAX_PATH * 3, L"%ls\\app\\index.html", dir);
    if (!exists(index)) { MessageBoxW(NULL, L"Brak plików aplikacji (app\\index.html). Zainstaluj ponownie ClipForge.", L"ClipForge", MB_ICONERROR); return 1; }
    /* build file:/// URL */
    wchar_t *o = url; o += swprintf(o, 16, L"file:///");
    for (wchar_t *c = index; *c; c++) {
        if (*c == L'\\') *o++ = L'/';
        else if (*c == L' ') { *o++ = L'%'; *o++ = L'2'; *o++ = L'0'; }
        else if (*c == L'#') { *o++ = L'%'; *o++ = L'2'; *o++ = L'3'; }
        else *o++ = *c;
    }
    *o = 0;
    if (!findBrowser(browser, MAX_PATH)) {
        MessageBoxW(NULL, L"Nie znaleziono Microsoft Edge ani Google Chrome. Otwieram w domyślnej przeglądarce.", L"ClipForge", MB_ICONINFORMATION);
        ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL); return 0;
    }
    if (SHGetFolderPathW(NULL, CSIDL_LOCAL_APPDATA, NULL, 0, data) != S_OK) GetTempPathW(MAX_PATH, data);
    wcscat(data, L"\\ClipForge\\profile");
    SHCreateDirectoryExW(NULL, data, NULL);
    swprintf(args, MAX_PATH * 8,
        L"\"%ls\" --app=\"%ls\" --user-data-dir=\"%ls\" --no-first-run --no-default-browser-check "
        L"--allow-file-access-from-files --autoplay-policy=no-user-gesture-required --window-size=1360,860 "
        L"--disable-features=Translate --class=ClipForge",
        browser, url, data);
    STARTUPINFOW si = { sizeof(si) }; PROCESS_INFORMATION pi;
    if (!CreateProcessW(browser, args, NULL, NULL, FALSE, 0, NULL, dir, &si, &pi)) {
        ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL); return 0;
    }
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    return 0;
}
