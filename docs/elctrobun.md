Compatibility
Dependencies and Versions
Dependency    Version    Notes
Bun    1.3.0
Zig    0.13.0
CEF    125.0.22    optionally bundled
Platform Support
Development Platform
macOS: Required for building Electrobun apps (Intel and Apple Silicon supported)
Windows: Development support available
Linux: Development support available
Target Platforms
Apps built with Electrobun can be distributed to:

    Platform    Architecture    Status    Notes
    macOS    ARM64 (Apple Silicon)    ✅ Stable    Full support with system WebKit
    macOS    x64 (Intel)    ✅ Stable    Full support with system WebKit
    Windows    x64    ✅ Stable    WebView2 (Edge) or bundled CEF
    Windows    ARM64    ✅ Via Emulation    Runs x64 binary through Windows emulation
    Linux    x64    ✅ Stable    WebKitGTK or bundled CEF
    Linux    ARM64    ✅ Stable    WebKitGTK or bundled CEF
    Webview Engines
    Electrobun supports both system webviews and bundled engines:

    Platform    System Webview    Bundled Option
    macOS    WebKit (WKWebView)    CEF (Chromium) - Optional
    Windows    WebView2 (Edge)    CEF (Chromium) - Optional
    Linux    WebKitGTK    CEF (Chromium) - Optional Compatibility
    Dependencies and Versions
    Dependency    Version    Notes
    Bun    1.3.0
    Zig    0.13.0
    CEF    125.0.22    optionally bundled
    Platform Support
    Development Platform
    macOS: Required for building Electrobun apps (Intel and Apple Silicon supported)
    Windows: Development support available
    Linux: Development support available
    Target Platforms
    Apps built with Electrobun can be distributed to:

    Platform    Architecture    Status    Notes
    macOS    ARM64 (Apple Silicon)    ✅ Stable    Full support with system WebKit
    macOS    x64 (Intel)    ✅ Stable    Full support with system WebKit
    Windows    x64    ✅ Stable    WebView2 (Edge) or bundled CEF
    Windows    ARM64    ✅ Via Emulation    Runs x64 binary through Windows emulation
    Linux    x64    ✅ Stable    WebKitGTK or bundled CEF
    Linux    ARM64    ✅ Stable    WebKitGTK or bundled CEF
    Webview Engines
    Electrobun supports both system webviews and bundled engines:

    Platform    System Webview    Bundled Option
    macOS    WebKit (WKWebView)    CEF (Chromium) - Optional
    Windows    WebView2 (Edge)    CEF (Chromium) - Optional
    Linux    WebKitGTK    CEF (Chromium) - Optional Code Signing
    Mac
    Apple often ships machines with expired certificates which is a huge pain. You can easily end up in a loop of
    generating certificates in the developer portal, installing them, and seeing the certificate is not trusted.

    You can avoid a lot of headaches by installing the full Xcode via the app store. Open XCode, click the app menu and
    the Settings. Go to the Accounts tab and add your developer account. Click "Manage Certificates". Then click the +
    sign and add a "Developer ID Application" certificate. If you open Keychain Access you should be able to see it if
    you search the Login keychain for "Developer ID Application". You can also log into the Apple Developer portal and
    look at your certificates and you'll see it there as well.

    Now in the developer portal go to Identifiers and click the plus sign to add one for your app. Make sure "App Attest"
     is checked so Electrobun's CLI can code sign and notarize your app. You may need other services if you need them.

    Now in another tab outside the Apple developer portal log into your apple account https://account.apple.com/sign-in.
    Go to "App Specific Passwords" and Create one for your Electrobun usage, this will be your ELECTROBUN_APPLEIDPASS
    that the Electrobun CLI will use to notarize your apps.

    Now we need to get some values that you will add to your .zshrc file. Here is the mapping of those values and where
    to find them

    ELECTROBUN_DEVELOPER_ID: In Apple Dev Portal open the certificate you created. The certificate name (probably your
    company name). eg: "My Corp Inc."

    ELECTROBUN_TEAMID: In the Apple Dev Portal open the App Identifier you created for your app. Under "App ID Prefix"
    you'll see something like "BGU899NB8T (Team ID)" it's the "BGU899NB8T" part.

    ELECTROBUN_APPLEID: This is your apple id email address, likely your personal apple id email address

    ELECTROBUN_APPLEIDPASS: This is the app specific password you created for Electrobun code signing
    Now open your .zshrc file and add the following lines so that they're in your env

    export ELECTROBUN_DEVELOPER_ID="ELECTROBUN_DEVELOPER_ID: My Corp Inc. (BGU899NB8T)"
    export ELECTROBUN_TEAMID="BGU899NB8T"
    export ELECTROBUN_APPLEID="myemail@email.com"
    export ELECTROBUN_APPLEIDPASS="your-app-specific-password"
    Now in your electrobun.config file make sure Build.mac.codesign and build.mac.notarize are set to true. eg:

    {
        "build": {
            "mac": {
                "codesign": true,
                "notarize": true,
            }
        }
    }
    Restart your terminal. You can confirm your env is setup correctly by entering the following and hitting enter to see
     if it outputs the value in your .zshrc file. You may need to restart or add it to a different file if it doesn't.

    echo $ELECTROBUN_TEAMID
    The next time you build your app the Electrobun CLI will sign and notarize your app, then compress it into the self
    extractor and sign and notarize the self extractor for you.

    Unsigned Apps
    If you distribute an unsigned app (with codesign: false), users who download it from the internet will see a "damaged
     and can't be opened" error when trying to launch it. This happens because macOS adds a quarantine attribute to
    downloaded files, and Gatekeeper blocks unsigned quarantined apps.

    To run an unsigned app that was downloaded from the internet, users need to remove the quarantine attribute:

    xattr -cr /Applications/YourApp.app
    After running this command, the app should open normally. Note that this is only necessary for apps downloaded from
    the internet - apps built and run locally don't have the quarantine attribute.

    For production apps intended for end users, it's strongly recommended to enable code signing and notarization for the
     best user experience. Architecture Overview
    High Level App Architecture
    An Electrobun app is essentially a Bun app. A tiny launcher (typically a zig binary) will run a Bun app. Since native
     GUI's require a blocking event loop on the main thread the main Bun thread will create a webworker with your code
    and then use Bun's FFI to init the native GUI event loop. Your Bun code running in the worker can then use
    Electrobun's apis, many of which also call Electrobun's native wrapper code via Bun's FFI to open windows, create
    system trays, relay events and RPC, and so on.

    Application Bundles
    MacOS
    Your Installed App
    On MacOS an application bundle is really just a folder with a .app file extension. The key subfolders inside are

    // electrobun places several binaries here. If bundling additional binaries on Mac and code-signing you must place
    them here
    /Contents/MacOS

    // An optimized zig implementation of bspatch used to generate and apply diffs during updates
    /Contents/MacOS/bspatch

    // The bun runtime
    /Contents/MacOS/bun

    // An optimized zig binary that typically just calls `bun index.js` with the included runtime
    // to run your compiled bun entrypoint file.
    /Contents/MacOS/launcher

    // A library containing Electrobun's native code layer for the platform, on MacOS this these are
    // objc/c++ code for interfacing with MacOS apis like NSWindow and WKWebkit
    /Contents/MacOS/libNativeWrapper.dylib

    // electrobun compiles your application's custom code here
    /Contents/MacOS/Resources

    // Your application icons
    /Contents/MacOS/Resources/AppIcon.icns

    // Local version info that `Electrobun.Updater` reads
    /Contents/MacOS/Resources/version.json

    // Folder containing the bundled javascript code for the main bun process.
    // Use electrobun.config to tell Electrobun where your ts entrypoing is and
    // define external dependencies
    /Contents/MacOS/Resources/app/bun/

    // This is where your views defined in electrobun.config.ts are transpiled to
    // Browserviews can also use the views:// url schema anywhere urls are loaded
    // to load bundled static content from here.
    /Contents/MacOS/Resources/app/views
    IPC
    In order to communicate between bun and browser contexts Electrobun has several mechanisms for establishing IPC
    between the processes involved. For the most part Electrobun uses postmessage and FFI but will also use more
    efficient encrypted web sockets.

    Self-Extracting Bundle
    Because zip file compression is not the best and we want apps you build with Electrobun to be as tiny as possible
    Electron automatically bundles your application into a self-extracting ZSTD bundle. Electrobun takes your entire app
    bundle, tars it, compresses it with zlib which is fast best-in-class modern compression and creates a second wrapper
    app bundle for distribution.

    Info: The current Electrobun Playground app is 50.4MB in size (most of this is the bun runtime), but when compressed
    and distributed as the self-extracting bundle it's only 13.1MB which is almost 5 times smaller. Meaning almost 5
    times as many users can download your app for the same cost in Storage and Network fees.
    The self-extracting bundle looks like this:

    // This is different from the regular launcher binary. It's a zig binary that uses zlip to decompress your actual app
     bundle
    /Contents/MacOS/launcher

    // App icons are actually stored again so the self-extractor looks just like your extracted bundled app.
    /Contents/Resources/AppIcons.icns

    // Your actual app bundled, tarred, and compressed with the name set to the hash
    /Contents/Resources/23fajlkj2.tar.zst
    A user can install the self-extracting bundle the same as any other application in the /Applications/ folder or run
    it from any folder on your machine. When your end-user double clicks to open it, it will transparently self-extract
    and replace itself with your full application and then launch the full application. To your user it just looks like
    the first time opening your app takes 1 or 2 seconds longer.

    The self-extraction process only happens on first install and is entirely local and self-contained using only a
    designated application support folder for your app for the extraction and verification.

    DMG
    Finally electrobun will automatically generate a DMG with the self-extracting bundle inside.

    Code Signing and Notarization
    Electrobun will automatically code sign and notarize your application for you.

    MacOS
    There is a prerequisite to register for an Apple Developer account and create an app id as well as download your code
     signing certificate. We'll have a guide that walks you through this process. There is no need to have any private
    keys in your code repo but you do need to set codesigning and notarization flags to true in your electrobun.config
    file and make some credentials available in your env.

    On MacOS Electrobun will code sign and notarize both your app bundle and the self-extracting bundle so your end-users
     can be confident that what their installing is legitimately from you and has been scanned by Apple.

    While code signing is generally very fast, notarization requires uploading a zip file to Apple's servers and waiting
    for them to scan and verify your app's code which typically takes about 1-2 minutes. The notarization is then stapled
     to your app bundle.

    Because notarization can take time, in cases where a bug only exists on non-dev builds you can simply turn off code
    signing and/or notarization in your electrobun.config while debugging to speed up the build process.

    Any notarization issues will be shown to you in the terminal so you can address them. This typically involves setting
     certain entitlements for your application so that your app declares what it uses to Apple and your end-users.

    Updating
    Electrobun has a built-in update mechanism that optimizes updates for file-size and efficiency.

    Info: Ship updates to your users as small as 14KB. This lets your ship often without paying huge storage and network
    fees. No server required, all you need is a static file host like S3 which you can put behind a CDN like Cloudfront.
    Most apps will fall well within AWS's free tier even if you ship updates often to many users.
    How does it work
    Using the Electrobun Updater api you can check for updates and automatically download, and install them. The flow
    looks something like:

    Check the local version.json hash against the hosted update.json hash of the latest version.
    If it's different download the tiny patch file that matches the hash you have (generated with BSDIFF) and apply it to
     the current bundle.
    Generate a hash of the patched bundle. If it matches the latest hash then replace the running application with the
    latest version of the app and relaunch (you can control when with the api and let the user trigger this manually when
     they're ready)
    If the hash does not match the latest look for another patch file and keep patching until it does.
    If for some reason the algorithm can't patch its way to the latest version it will download a zlib compressed bundle
    from your static host and complete the update that way.
    Info: Whenever you build a non-dev build of your app the electrobun cli will automatically generate a patch from the
    current hosted version to the newly built version. It's completely up to you how many patches you make available on
    your static host.
    CLI and development builds
    The Electrobun cli is automatically installed locally to your project when you bun install electrobun. You can then
    add npm scripts and an electrobun.config file to build your app.

    Development Builds
    When building a dev build of your app instead of the optimized launcher binary the cli uses a special dev launcher
    binary which routes any bun, zig, and native output to your terminal.

    Dev builds are not meant to be distributed and so the cli does not generate artifacts for dev builds.

    Distribution
    When building canary and stable builds of your app Electrobun will generate an artifacts folder that contains
    everything you need to upload to a static host for distribution and updates. docs
