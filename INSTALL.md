# Installing Trove on macOS

Trove ships as an unsigned `.dmg`. macOS will block it on first launch unless
you take **one extra step** to clear the "downloaded from the internet"
quarantine flag. This is a one-time fix per install — after that, Trove opens
normally.

## Step-by-step

1. **Download** the DMG from the [latest release page](https://github.com/Liko209/trove/releases/latest).
2. **Open the DMG** and drag **Trove** into the Applications folder.
3. **Open Terminal** (Applications → Utilities → Terminal) and run:
   ```
   xattr -cr /Applications/Trove.app
   ```
4. **Double-click Trove** in Applications. It will open and walk you through setup.

## "Trove is damaged and can't be opened"

If you see this dialog, it means you skipped step 3. The app **is not** actually
damaged — that's just macOS's generic warning for any unsigned app downloaded
from a browser. Open Terminal and run:

```
xattr -cr /Applications/Trove.app
```

Then try opening Trove again. It will work.

## Why this is necessary

macOS adds a `com.apple.quarantine` flag to files downloaded by browsers. For
**unsigned** apps (apps that don't carry an Apple Developer ID signature),
macOS Gatekeeper refuses to run them when this flag is present, and — since
macOS 15 — no longer offers the "right-click → Open" bypass path. The `xattr`
command above removes the flag.

A signed and notarized build (which would skip this step entirely) requires an
Apple Developer Program membership ($99/year). That's on the roadmap.

## Upgrading

Once Trove is installed, **subsequent versions auto-update** through the
built-in updater. You won't need to repeat the `xattr` step for updates — only
fresh installs.
