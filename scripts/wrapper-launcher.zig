const std = @import("std");

const HANDLE = *anyopaque;
const HWND = ?*anyopaque;
const HINSTANCE = ?*anyopaque;
const HICON = ?*anyopaque;
const HBRUSH = ?*anyopaque;
const HCURSOR = ?*anyopaque;
const HBITMAP = ?*anyopaque;
const HDC = ?*anyopaque;
const HMENU = ?*anyopaque;
const HFONT = ?*anyopaque;
const HGDIOBJ = ?*anyopaque;
const BOOL = i32;
const DWORD = u32;
const WORD = u16;
const UINT = u32;
const INT = i32;
const LONG = i32;
const WPARAM = usize;
const LPARAM = isize;
const LRESULT = isize;
const LPWSTR = ?[*:0]u16;
const LPCWSTR = ?[*:0]const u16;
const COLORREF = DWORD;

const STARTUPINFOW = extern struct {
    cb: DWORD = @sizeOf(STARTUPINFOW),
    lpReserved: LPWSTR = null,
    lpDesktop: LPWSTR = null,
    lpTitle: LPWSTR = null,
    dwX: DWORD = 0,
    dwY: DWORD = 0,
    dwXSize: DWORD = 0,
    dwYSize: DWORD = 0,
    dwXCountChars: DWORD = 0,
    dwYCountChars: DWORD = 0,
    dwFillAttribute: DWORD = 0,
    dwFlags: DWORD = 0,
    wShowWindow: WORD = 0,
    cbReserved2: WORD = 0,
    lpReserved2: ?*u8 = null,
    hStdInput: ?HANDLE = null,
    hStdOutput: ?HANDLE = null,
    hStdError: ?HANDLE = null,
};

const PROCESS_INFORMATION = extern struct {
    hProcess: ?HANDLE = null,
    hThread: ?HANDLE = null,
    dwProcessId: DWORD = 0,
    dwThreadId: DWORD = 0,
};

const WNDCLASSEXW = extern struct {
    cbSize: UINT = @sizeOf(WNDCLASSEXW),
    style: UINT = 0,
    lpfnWndProc: ?*const fn (HWND, UINT, WPARAM, LPARAM) callconv(.winapi) LRESULT = null,
    cbClsExtra: INT = 0,
    cbWndExtra: INT = 0,
    hInstance: HINSTANCE = null,
    hIcon: HICON = null,
    hCursor: HCURSOR = null,
    hbrBackground: HBRUSH = null,
    lpszMenuName: LPCWSTR = null,
    lpszClassName: LPCWSTR = null,
    hIconSm: HICON = null,
};

const PAINTSTRUCT = extern struct {
    hdc: HDC = null,
    fErase: BOOL = 0,
    rcPaint: RECT = .{},
    fRestore: BOOL = 0,
    fIncUpdate: BOOL = 0,
    rgbReserved: [32]u8 = [_]u8{0} ** 32,
};

const RECT = extern struct {
    left: LONG = 0,
    top: LONG = 0,
    right: LONG = 0,
    bottom: LONG = 0,
};

const MSG = extern struct {
    hwnd: HWND = null,
    message: UINT = 0,
    wParam: WPARAM = 0,
    lParam: LPARAM = 0,
    time: DWORD = 0,
    pt_x: LONG = 0,
    pt_y: LONG = 0,
};

// kernel32
extern "kernel32" fn CreateProcessW(?[*:0]const u16, ?[*:0]u16, ?*anyopaque, ?*anyopaque, BOOL, DWORD, ?*anyopaque, ?[*:0]const u16, *STARTUPINFOW, *PROCESS_INFORMATION) callconv(.winapi) BOOL;
extern "kernel32" fn CloseHandle(HANDLE) callconv(.winapi) BOOL;
extern "kernel32" fn GetExitCodeProcess(HANDLE, *DWORD) callconv(.winapi) BOOL;
extern "kernel32" fn GlobalAlloc(UINT, usize) callconv(.winapi) ?HANDLE;
extern "kernel32" fn GlobalFree(HANDLE) callconv(.winapi) ?HANDLE;
extern "kernel32" fn GlobalLock(HANDLE) callconv(.winapi) ?*anyopaque;
extern "kernel32" fn GlobalUnlock(HANDLE) callconv(.winapi) BOOL;
extern "kernel32" fn GetModuleHandleW(?[*:0]const u16) callconv(.winapi) HINSTANCE;
extern "kernel32" fn Sleep(DWORD) callconv(.winapi) void;
extern "kernel32" fn SetEnvironmentVariableW([*:0]const u16, ?[*:0]const u16) callconv(.winapi) BOOL;

// user32
extern "user32" fn RegisterClassExW(*const WNDCLASSEXW) callconv(.winapi) u16;
extern "user32" fn CreateWindowExW(DWORD, [*:0]const u16, [*:0]const u16, DWORD, INT, INT, INT, INT, HWND, HMENU, HINSTANCE, ?*anyopaque) callconv(.winapi) HWND;
extern "user32" fn ShowWindow(HWND, INT) callconv(.winapi) BOOL;
extern "user32" fn UpdateWindow(HWND, ) callconv(.winapi) BOOL;
extern "user32" fn DestroyWindow(HWND) callconv(.winapi) BOOL;
extern "user32" fn DefWindowProcW(HWND, UINT, WPARAM, LPARAM) callconv(.winapi) LRESULT;
extern "user32" fn PeekMessageW(*MSG, HWND, UINT, UINT, UINT) callconv(.winapi) BOOL;
extern "user32" fn TranslateMessage(*const MSG) callconv(.winapi) BOOL;
extern "user32" fn DispatchMessageW(*const MSG) callconv(.winapi) LRESULT;
extern "user32" fn GetSystemMetrics(INT) callconv(.winapi) INT;
extern "user32" fn BeginPaint(HWND, *PAINTSTRUCT) callconv(.winapi) HDC;
extern "user32" fn EndPaint(HWND, *const PAINTSTRUCT) callconv(.winapi) BOOL;
extern "user32" fn FillRect(HDC, *const RECT, HBRUSH) callconv(.winapi) INT;
extern "user32" fn DrawTextW(HDC, [*]const u16, INT, *RECT, UINT) callconv(.winapi) INT;
extern "user32" fn SetTimer(HWND, usize, UINT, ?*anyopaque) callconv(.winapi) usize;
extern "user32" fn KillTimer(HWND, usize) callconv(.winapi) BOOL;
extern "user32" fn PostQuitMessage(INT) callconv(.winapi) void;
extern "user32" fn InvalidateRect(HWND, ?*const RECT, BOOL) callconv(.winapi) BOOL;
extern "user32" fn IsWindowVisible(HWND) callconv(.winapi) BOOL;
extern "user32" fn EnumWindows(*const fn (HWND, LPARAM) callconv(.winapi) BOOL, LPARAM) callconv(.winapi) BOOL;
extern "user32" fn GetWindowTextW(HWND, [*]u16, INT) callconv(.winapi) INT;
extern "user32" fn MessageBoxW(HWND, [*:0]const u16, [*:0]const u16, UINT) callconv(.winapi) INT;
extern "user32" fn OpenClipboard(HWND) callconv(.winapi) BOOL;
extern "user32" fn EmptyClipboard() callconv(.winapi) BOOL;
extern "user32" fn SetClipboardData(UINT, HANDLE) callconv(.winapi) ?HANDLE;
extern "user32" fn CloseClipboard() callconv(.winapi) BOOL;

// gdi32
extern "gdi32" fn CreateSolidBrush(COLORREF) callconv(.winapi) HBRUSH;
extern "gdi32" fn CreateFontW(INT, INT, INT, INT, INT, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, ?[*:0]const u16) callconv(.winapi) HFONT;
extern "gdi32" fn SelectObject(HDC, HGDIOBJ) callconv(.winapi) HGDIOBJ;
extern "gdi32" fn SetTextColor(HDC, COLORREF) callconv(.winapi) COLORREF;
extern "gdi32" fn SetBkMode(HDC, INT) callconv(.winapi) INT;
extern "gdi32" fn DeleteObject(HGDIOBJ) callconv(.winapi) BOOL;

// Constants
const WS_POPUP: DWORD = 0x80000000;
const WS_VISIBLE: DWORD = 0x10000000;
const WS_EX_TOPMOST: DWORD = 0x00000008;
const WS_EX_TOOLWINDOW: DWORD = 0x00000080;
const WM_PAINT: UINT = 0x000F;
const WM_TIMER: UINT = 0x0113;
const WM_DESTROY: UINT = 0x0002;
const WM_QUIT: UINT = 0x0012;
const SM_CXSCREEN: INT = 0;
const SM_CYSCREEN: INT = 1;
const DT_CENTER: UINT = 0x01;
const DT_VCENTER: UINT = 0x04;
const DT_SINGLELINE: UINT = 0x20;
const CREATE_NO_WINDOW: DWORD = 0x08000000;
const TRANSPARENT: INT = 1;
const FW_NORMAL: INT = 400;
const FW_SEMIBOLD: INT = 600;
const PM_REMOVE: UINT = 0x0001;
const SW_SHOW: INT = 5;
const STILL_ACTIVE: DWORD = 259;
const GMEM_MOVEABLE: UINT = 0x0002;
const CF_UNICODETEXT: UINT = 13;
const MB_OK: UINT = 0x00000000;
const MB_ICONERROR: UINT = 0x00000010;
const MB_SETFOREGROUND: UINT = 0x00010000;

// Splash dimensions
const SPLASH_W: INT = 420;
const SPLASH_H: INT = 240;
const BG_COLOR: COLORREF = 0x00111111; // #111111 (BGR)
const TEXT_COLOR: COLORREF = 0x0060A8C0; // #C0A860 gold (BGR)
const SUB_COLOR: COLORREF = 0x00808080; // #808080 gray (BGR)
const TIMER_ID: usize = 1;
const TIMER_MS: UINT = 100; // Fast timer for smooth progress bar animation

// Global state
var g_frame: u32 = 0;
var g_found_count: u32 = 0; // consecutive detections of main window
var g_main_visible: bool = false; // set by EnumWindows callback
var g_version_buf: [32]u16 = [_]u16{0} ** 32;
var g_version_len: usize = 0; // 0 = no version loaded

// ── Helpers ─────────────────────────────────────────────────────────

fn containsU16(haystack: []const u16, needle: []const u16) bool {
    if (needle.len == 0 or needle.len > haystack.len) return false;
    var i: usize = 0;
    while (i + needle.len <= haystack.len) : (i += 1) {
        if (std.mem.eql(u16, haystack[i..][0..needle.len], needle)) return true;
    }
    return false;
}

fn enumCallback(hwnd: HWND, _: LPARAM) callconv(.winapi) BOOL {
    var title_buf: [256]u16 = undefined;
    const len = GetWindowTextW(hwnd, &title_buf, 256);
    if (len < 7) return 1; // "KeepKey" is 7 chars minimum
    const title = title_buf[0..@as(usize, @intCast(len))];

    // Match any window containing "KeepKey" (covers "KeepKey Vault", "KeepKey Vault vX.Y.Z", etc.)
    const kk = [_]u16{ 'K', 'e', 'e', 'p', 'K', 'e', 'y' };
    // Also match dev title "keepkey-vault"
    const dev = [_]u16{ 'k', 'e', 'e', 'p', 'k', 'e', 'y', '-', 'v', 'a', 'u', 'l', 't' };

    if (containsU16(title, &kk) or containsU16(title, &dev)) {
        if (IsWindowVisible(hwnd) != 0) {
            g_main_visible = true;
            return 0; // stop enumeration
        }
    }
    return 1; // continue
}

fn loadVersion(exe_dir: []const u8, alloc: std.mem.Allocator) void {
    const path = std.fs.path.join(alloc, &.{ exe_dir, "Resources", "version.json" }) catch return;
    defer alloc.free(path);

    const file = std.fs.cwd().openFile(path, .{}) catch return;
    defer file.close();

    var file_buf: [2048]u8 = undefined;
    const n = file.read(&file_buf) catch return;
    const content = file_buf[0..n];

    // Extract version from "version":"X.Y.Z" (handles optional spaces around colon)
    const key = "\"version\"";
    const idx = std.mem.indexOf(u8, content, key) orelse return;
    var pos = idx + key.len;
    while (pos < content.len and (content[pos] == ':' or content[pos] == ' ')) : (pos += 1) {}
    if (pos >= content.len or content[pos] != '"') return;
    pos += 1;
    const start = pos;
    while (pos < content.len and content[pos] != '"') : (pos += 1) {}
    if (pos >= content.len) return;
    const ver = content[start..pos];

    if (ver.len == 0 or ver.len > 30) return;

    // Write "vX.Y.Z" into g_version_buf as UTF-16LE
    g_version_buf[0] = 'v';
    var out: usize = 1;
    for (ver) |c| {
        g_version_buf[out] = @intCast(c);
        out += 1;
    }
    g_version_buf[out] = 0; // null terminate
    g_version_len = out;
}

/// Put a deliberately small, non-sensitive startup diagnostic on the Windows
/// clipboard. Ownership of `memory` transfers to the clipboard on success.
fn copyDiagnosticToClipboard(text: []const u16) bool {
    if (OpenClipboard(null) == 0) return false;
    defer _ = CloseClipboard();
    if (EmptyClipboard() == 0) return false;

    const byte_len = (text.len + 1) * @sizeOf(u16);
    const memory = GlobalAlloc(GMEM_MOVEABLE, byte_len) orelse return false;
    const raw = GlobalLock(memory) orelse {
        _ = GlobalFree(memory);
        return false;
    };
    const dest: [*]u16 = @ptrCast(@alignCast(raw));
    @memcpy(dest[0..text.len], text);
    dest[text.len] = 0;
    _ = GlobalUnlock(memory);

    if (SetClipboardData(CF_UNICODETEXT, memory) == null) {
        _ = GlobalFree(memory);
        return false;
    }
    return true;
}

fn showStartupHelp(alloc: std.mem.Allocator, launcher_process: ?HANDLE) void {
    var exit_code: DWORD = 0;
    const launcher_state = if (launcher_process) |process| state: {
        if (GetExitCodeProcess(process, &exit_code) == 0) break :state "unknown";
        break :state if (exit_code == STILL_ACTIVE) "running" else "exited";
    } else "not-started";

    const version = if (g_version_len > 1)
        std.unicode.utf16LeToUtf8Alloc(alloc, g_version_buf[1..g_version_len]) catch "unknown"
    else
        "unknown";
    const report_utf8 = std.fmt.allocPrint(
        alloc,
        "KeepKey Vault startup report\r\nVersion: {s}\r\nPlatform: Windows x64\r\nFailure: no application window after 30 seconds\r\nLauncher: {s}\r\nExit code: {d}\r\n",
        .{ version, launcher_state, exit_code },
    ) catch return;
    const report = std.unicode.utf8ToUtf16LeAlloc(alloc, report_utf8) catch return;
    const copied = copyDiagnosticToClipboard(report);

    const message = if (copied)
        "KeepKey Vault did not open after 30 seconds.\n\nA non-sensitive startup report has been copied to your clipboard. Go to keepkey.com/support and paste it into your support request.\n\nThe report contains only the Vault version, platform, startup failure, and launcher status."
    else
        "KeepKey Vault did not open after 30 seconds.\n\nGo to keepkey.com/support and report that the Windows application showed no window. No diagnostic data was sent."
    ;
    const message_w = std.unicode.utf8ToUtf16LeAllocZ(alloc, message) catch return;
    _ = MessageBoxW(
        null,
        message_w,
        std.unicode.utf8ToUtf16LeStringLiteral("KeepKey Vault could not open"),
        MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
    );
}

// ── Splash window procedure ─────────────────────────────────────────

fn splashWndProc(hwnd: HWND, msg: UINT, wp: WPARAM, lp: LPARAM) callconv(.winapi) LRESULT {
    switch (msg) {
        WM_PAINT => {
            var ps = PAINTSTRUCT{};
            const hdc = BeginPaint(hwnd, &ps);
            if (hdc) |dc| {
                // Fill background #111111
                var rc = RECT{ .left = 0, .top = 0, .right = SPLASH_W, .bottom = SPLASH_H };
                const bg = CreateSolidBrush(BG_COLOR);
                _ = FillRect(dc, &rc, bg);
                _ = DeleteObject(@ptrCast(bg));

                // Gold accent line at top (2px)
                var accent_rc = RECT{ .left = 0, .top = 0, .right = SPLASH_W, .bottom = 2 };
                const gold_brush = CreateSolidBrush(TEXT_COLOR);
                _ = FillRect(dc, &accent_rc, gold_brush);
                _ = DeleteObject(@ptrCast(gold_brush));

                _ = SetBkMode(dc, TRANSPARENT);

                // Title: "KeepKey Vault" — large gold text
                const title_font = CreateFontW(36, 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, 0, 0, 0, 0, 0, std.unicode.utf8ToUtf16LeStringLiteral("Segoe UI"));
                if (title_font) |f| {
                    _ = SelectObject(dc, @ptrCast(f));
                    _ = SetTextColor(dc, TEXT_COLOR);
                    var title_rc = RECT{ .left = 0, .top = 55, .right = SPLASH_W, .bottom = 105 };
                    _ = DrawTextW(dc, std.unicode.utf8ToUtf16LeStringLiteral("KeepKey Vault").ptr, -1, &title_rc, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
                    _ = DeleteObject(@ptrCast(f));
                }

                // Animated progress bar (gold on dark gray track)
                const bar_y: INT = 135;
                const bar_h: INT = 3;
                const bar_margin: INT = 60;
                var track_rc = RECT{ .left = bar_margin, .top = bar_y, .right = SPLASH_W - bar_margin, .bottom = bar_y + bar_h };
                const track_brush = CreateSolidBrush(0x00333333);
                _ = FillRect(dc, &track_rc, track_brush);
                _ = DeleteObject(@ptrCast(track_brush));

                // Sliding gold segment (bounces back and forth)
                const track_w = SPLASH_W - bar_margin * 2;
                const seg_w: INT = 80;
                const cycle: INT = @intCast(g_frame % 40);
                const pos: INT = if (cycle < 20) cycle else 40 - cycle;
                const seg_x = bar_margin + @divTrunc(pos * (track_w - seg_w), @as(INT, 20));
                var seg_rc = RECT{ .left = seg_x, .top = bar_y, .right = seg_x + seg_w, .bottom = bar_y + bar_h };
                const seg_brush = CreateSolidBrush(TEXT_COLOR);
                _ = FillRect(dc, &seg_rc, seg_brush);
                _ = DeleteObject(@ptrCast(seg_brush));

                // Status text
                const sub_font = CreateFontW(14, 0, 0, 0, FW_NORMAL, 0, 0, 0, 0, 0, 0, 0, 0, std.unicode.utf8ToUtf16LeStringLiteral("Segoe UI"));
                if (sub_font) |f| {
                    _ = SelectObject(dc, @ptrCast(f));
                    _ = SetTextColor(dc, SUB_COLOR);
                    var sub_rc = RECT{ .left = 0, .top = 155, .right = SPLASH_W, .bottom = 180 };
                    // Slow phase changes (~8 seconds each at 100ms timer)
                    const phase = (g_frame / 80) % 3;
                    const label = switch (phase) {
                        0 => std.unicode.utf8ToUtf16LeStringLiteral("Initializing secure environment..."),
                        1 => std.unicode.utf8ToUtf16LeStringLiteral("Loading application..."),
                        else => std.unicode.utf8ToUtf16LeStringLiteral("Preparing workspace..."),
                    };
                    _ = DrawTextW(dc, label.ptr, -1, &sub_rc, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
                    _ = DeleteObject(@ptrCast(f));
                }

                // Version at bottom (read from Resources/version.json at startup)
                if (g_version_len > 0) {
                    const ver_font = CreateFontW(11, 0, 0, 0, FW_NORMAL, 0, 0, 0, 0, 0, 0, 0, 0, std.unicode.utf8ToUtf16LeStringLiteral("Segoe UI"));
                    if (ver_font) |f| {
                        _ = SelectObject(dc, @ptrCast(f));
                        _ = SetTextColor(dc, 0x00444444);
                        var ver_rc = RECT{ .left = 0, .top = SPLASH_H - 25, .right = SPLASH_W, .bottom = SPLASH_H - 5 };
                        _ = DrawTextW(dc, &g_version_buf, @intCast(g_version_len), &ver_rc, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
                        _ = DeleteObject(@ptrCast(f));
                    }
                }
            }
            _ = EndPaint(hwnd, &ps);
            return 0;
        },
        WM_TIMER => {
            g_frame += 1;
            _ = InvalidateRect(hwnd, null, 0);

            // Check if any window with "KeepKey" in the title is visible.
            // Uses EnumWindows for version-independent detection — no hardcoded titles.
            g_main_visible = false;
            _ = EnumWindows(enumCallback, 0);

            if (g_main_visible) {
                g_found_count += 1;
                // Require 15 consecutive detections (1.5s at 100ms timer)
                if (g_found_count >= 15) {
                    _ = KillTimer(hwnd, TIMER_ID);
                    _ = DestroyWindow(hwnd);
                    return 0;
                }
            } else {
                g_found_count = 0; // Reset on miss — must be truly consecutive
            }
            return 0;
        },
        WM_DESTROY => {
            PostQuitMessage(0);
            return 0;
        },
        else => return DefWindowProcW(hwnd, msg, wp, lp),
    }
}

pub fn main() !void {
    const alloc = std.heap.page_allocator;

    var buf: [1024]u8 = undefined;
    const exe_dir = std.fs.selfExeDirPath(&buf) catch return;

    var arena = std.heap.ArenaAllocator.init(alloc);
    defer arena.deinit();
    const a = arena.allocator();

    // Load version from Resources/version.json for splash display
    loadVersion(exe_dir, a);

    // ── Show splash window immediately ──────────────────────────────
    const hInst = GetModuleHandleW(null);
    const class_name = std.unicode.utf8ToUtf16LeStringLiteral("KeepKeySplash");

    var wc = WNDCLASSEXW{};
    wc.lpfnWndProc = splashWndProc;
    wc.hInstance = hInst;
    wc.lpszClassName = class_name;
    wc.hbrBackground = CreateSolidBrush(BG_COLOR);
    _ = RegisterClassExW(&wc);

    // Center on screen
    const scr_w = GetSystemMetrics(SM_CXSCREEN);
    const scr_h = GetSystemMetrics(SM_CYSCREEN);
    const x = @divTrunc(scr_w - SPLASH_W, 2);
    const y = @divTrunc(scr_h - SPLASH_H, 2);

    const splash = CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_TOOLWINDOW, // topmost + no taskbar entry
        class_name,
        std.unicode.utf8ToUtf16LeStringLiteral(""),
        WS_POPUP | WS_VISIBLE,
        x,
        y,
        SPLASH_W,
        SPLASH_H,
        null,
        null,
        hInst,
        null,
    );

    if (splash) |s| {
        _ = ShowWindow(s, SW_SHOW);
        _ = UpdateWindow(s);
        _ = SetTimer(s, TIMER_ID, TIMER_MS, null);
    }

    // ── Launch the real app ─────────────────────────────────────────
    // Launch through Electrobun's stock launcher so BrowserWindow initializes
    // on the supported runtime path. Export BUN_OPTIONS so the launcher's Bun
    // child uses Windows' system CA store; without this, Bun's bundled CA set
    // can reject valid corporate/Windows trust chains and break api.keepkey.info.
    const bin_dir = try std.fs.path.join(a, &.{ exe_dir, "bin" });
    _ = SetEnvironmentVariableW(
        std.unicode.utf8ToUtf16LeStringLiteral("BUN_OPTIONS"),
        std.unicode.utf8ToUtf16LeStringLiteral("--use-system-ca"),
    );
    const launcher_path = try std.fs.path.join(a, &.{ bin_dir, "launcher.exe" });
    const cmd = try std.fmt.allocPrint(a, "\"{s}\"", .{launcher_path});
    const launcher_path_w = try std.unicode.utf8ToUtf16LeAllocZ(a, launcher_path);
    const cmd_w = try std.unicode.utf8ToUtf16LeAllocZ(a, cmd);
    const cwd_w = try std.unicode.utf8ToUtf16LeAllocZ(a, bin_dir);

    var si = STARTUPINFOW{};
    var pi = PROCESS_INFORMATION{};

    const ok = CreateProcessW(launcher_path_w, cmd_w, null, null, 0, CREATE_NO_WINDOW, null, cwd_w, &si, &pi);
    var launcher_process: ?HANDLE = null;
    if (ok != 0) {
        launcher_process = pi.hProcess;
        if (pi.hThread) |h| _ = CloseHandle(h);
    } else {
        // A missing/quarantined launcher should fail immediately instead of
        // making the user stare at the splash screen for thirty seconds.
        if (splash) |s| {
            _ = KillTimer(s, TIMER_ID);
            _ = DestroyWindow(s);
        }
        showStartupHelp(a, null);
        return;
    }
    defer {
        if (launcher_process) |h| _ = CloseHandle(h);
    }

    // ── Run message loop until splash is closed ─────────────────────
    // Splash auto-closes when it detects the main "KeepKey Vault" window.
    // Safety: also close after 30 seconds regardless.
    var msg_loop = MSG{};
    const start = @as(u32, @truncate(@as(u64, @bitCast(std.time.milliTimestamp()))));
    var startup_timed_out = false;
    var launcher_exited = false;
    while (true) {
        while (PeekMessageW(&msg_loop, null, 0, 0, PM_REMOVE) != 0) {
            if (msg_loop.message == WM_QUIT) return;
            _ = TranslateMessage(&msg_loop);
            _ = DispatchMessageW(&msg_loop);
        }
        Sleep(16); // ~60fps
        // If App Control or antivirus blocks a launcher dependency, Electrobun's
        // launcher exits before a window exists. Surface that immediately and
        // preserve its exit code in the clipboard report.
        if (launcher_process) |process| {
            var exit_code: DWORD = STILL_ACTIVE;
            if (GetExitCodeProcess(process, &exit_code) != 0 and exit_code != STILL_ACTIVE) {
                launcher_exited = true;
                break;
            }
        }
        const now = @as(u32, @truncate(@as(u64, @bitCast(std.time.milliTimestamp()))));
        if (now -% start > 30000) {
            startup_timed_out = true;
            break;
        }
    }

    if (startup_timed_out or launcher_exited) {
        if (splash) |s| {
            _ = KillTimer(s, TIMER_ID);
            _ = DestroyWindow(s);
        }
        showStartupHelp(a, launcher_process);
    }
}
