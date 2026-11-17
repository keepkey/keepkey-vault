#!/usr/bin/env python3
"""
collect.py — Resolve, download and normalize logos for the assets listed in
missing.json (written by scan.ts). No credentials needed.

Sources, in order:
  ERC-20/BEP-20 tokens
    1. CoinGecko (contract -> coin id via /coins/list?include_platform=true,
       image via /coins/markets)
    2. GeckoTerminal /networks/{net}/tokens/multi
    3. DexScreener /tokens/v1/{net}
  EVM native assets (eip155:N/slip44:60)
    1. ethereum-lists/chains icon (chainid.network/chains.json -> icons/<name>.json
       -> ipfs), fetched through public IPFS gateways
  Manual overrides: OVERRIDES below.

Every image is decoded with Pillow, flattened to RGBA and re-encoded as a real
128x128 PNG (the CDN currently has JPEGs stored under .png). Output:
  scripts/cdn-icons/icons/<cdn key basename>   (the files to upload)
  scripts/cdn-icons/manifest.json              (caip, key, source, sha256)
  scripts/cdn-icons/unresolved.json            (no public logo found)

Usage:
  uv run --no-project --with pillow --with cairosvg python scripts/cdn-icons/collect.py [--refresh] [--reencode]
  --refresh   re-resolve sources and re-download everything
  --reencode  re-encode icons already on disk (no download)
Re-running without flags resumes: files already in icons/ are kept and only
failures are retried.
Requires: Python 3.10+, Pillow, cairosvg (for SVG chain icons).
"""
import hashlib
import io
import json
import os
import sys
import time
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

DIR = Path(__file__).resolve().parent
OUT = DIR / "icons"
UA = {"User-Agent": "keepkey-vault-icon-backfill/1.0", "Accept": "application/json, image/*"}
SIZE = 128
MAX_BYTES = 2 * 1024 * 1024

GT_NET = {"8453": "base", "1": "eth", "56": "bsc", "42161": "arbitrum", "137": "polygon_pos", "10": "optimism"}
DEX_NET = {"8453": "base", "1": "ethereum", "56": "bsc", "42161": "arbitrum", "137": "polygon", "10": "optimism"}
CG_PLATFORM = {"8453": "base", "1": "ethereum", "56": "binance-smart-chain", "42161": "arbitrum-one",
               "137": "polygon-pos", "10": "optimistic-ethereum"}
# dweb.link / w3s.link / ipfs.io rate-limit (429) almost immediately.
IPFS_GATEWAYS = ["https://ipfs.filebase.io/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://dweb.link/ipfs/",
                 "https://ipfs.io/ipfs/", "https://w3s.link/ipfs/", "https://4everland.io/ipfs/"]
# Optional dedicated gateway, tried first (env or repo-root .env), e.g. a Pinata one:
#   IPFS_GATEWAY=https://<name>.mypinata.cloud/ipfs/   IPFS_GATEWAY_TOKEN=<pinata gateway key>
# The token goes in a header, never in the URL, so it can't leak into unresolved.json.
def _env(name: str) -> str:
    if os.environ.get(name):
        return os.environ[name]
    env = DIR.parent.parent / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            k, _, v = line.partition("=")
            if k.strip() == name:
                return v.strip().strip('"').strip("'")
    return ""


IPFS_GATEWAY = _env("IPFS_GATEWAY").rstrip("/") + "/" if _env("IPFS_GATEWAY") else ""
IPFS_GATEWAY_HEADERS = {"x-pinata-gateway-token": _env("IPFS_GATEWAY_TOKEN")} if _env("IPFS_GATEWAY_TOKEN") else {}
if IPFS_GATEWAY:
    IPFS_GATEWAYS.insert(0, IPFS_GATEWAY)
# DefiLlama mirror of chainlist icons (what chainlist.org itself serves); fallback when IPFS gateways fail.
LLAMA_CHAIN_ICON = "https://icons.llamao.fi/icons/chains/rsz_{}.jpg"
SOURCES_CACHE = DIR / ".sources-cache.json"

# Assets no automatic source resolves (CoinGecko image URLs, reviewed by hand).
OVERRIDES = {
    "cosmos:thorchain-1/slip44:tcy": "https://coin-images.coingecko.com/coins/images/55539/large/THORChain_TCY_Token.png",
}


def get(url: str, timeout: int = 30, tries: int = 3, max_bytes: int = MAX_BYTES, backoff_429: int = 30,
        headers: dict | None = None) -> bytes:
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={**UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read(max_bytes + 1)
                if len(data) > max_bytes:
                    raise ValueError("too large")
                return data
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 404:
                break
            time.sleep(backoff_429 * (attempt + 1) if e.code == 429 else 1)
        except Exception as e:  # noqa: BLE001 - network flakiness
            last = e
            time.sleep(1 + attempt)
    raise RuntimeError(f"{url}: {last}")


def get_json(url: str):
    return json.loads(get(url, timeout=120, tries=5, max_bytes=200 * 1024 * 1024))


def token_parts(caip: str):
    chain = caip.split("/")[0].split(":")[1]
    return chain, caip.split(":")[-1].lower()


def resolve_tokens(tokens: list[str]) -> dict[str, tuple[str, str]]:
    found: dict[str, tuple[str, str]] = {}

    # CoinGecko
    print("coingecko: coin list", file=sys.stderr)
    idx = {}
    for c in get_json("https://api.coingecko.com/api/v3/coins/list?include_platform=true"):
        for p, addr in (c.get("platforms") or {}).items():
            if addr:
                idx[(p, addr.lower())] = c["id"]
    by_id = defaultdict(list)
    for caip in tokens:
        chain, addr = token_parts(caip)
        cid = idx.get((CG_PLATFORM.get(chain), addr))
        if cid:
            by_id[cid].append(caip)
    ids = sorted(by_id)
    for i in range(0, len(ids), 250):
        rows = get_json("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&ids="
                        + ",".join(ids[i:i + 250]))
        for row in rows:
            img = row.get("image") or ""
            if img and "missing" not in img:
                for caip in by_id[row["id"]]:
                    found[caip] = ("coingecko", img)
        time.sleep(6)
    print(f"coingecko: {len(found)}", file=sys.stderr)

    rest = [c for c in tokens if c not in found]
    by_chain = defaultdict(list)
    for caip in rest:
        chain, addr = token_parts(caip)
        by_chain[chain].append((addr, caip))

    # GeckoTerminal (30 req/min public limit)
    for chain, items in by_chain.items():
        net = GT_NET.get(chain)
        if not net:
            continue
        lookup = {a: c for a, c in items}
        addrs = list(lookup)
        for i in range(0, len(addrs), 30):
            data = get_json(f"https://api.geckoterminal.com/api/v2/networks/{net}/tokens/multi/"
                            + ",".join(addrs[i:i + 30]))
            for d in data.get("data", []):
                at = d["attributes"]
                img = at.get("image_url") or ""
                caip = lookup.get(at["address"].lower())
                if caip and img and "missing" not in img and caip not in found:
                    found[caip] = ("geckoterminal", img)
            time.sleep(2.2)
    print(f"+geckoterminal: {len(found)}", file=sys.stderr)

    # DexScreener
    for chain, items in by_chain.items():
        net = DEX_NET.get(chain)
        if not net:
            continue
        lookup = {a: c for a, c in items if c not in found}
        addrs = list(lookup)
        for i in range(0, len(addrs), 30):
            pairs = get_json(f"https://api.dexscreener.com/tokens/v1/{net}/" + ",".join(addrs[i:i + 30]))
            for p in pairs:
                img = (p.get("info") or {}).get("imageUrl")
                caip = lookup.get(p["baseToken"]["address"].lower())
                if caip and img and caip not in found:
                    found[caip] = ("dexscreener", img)
            time.sleep(0.3)
    print(f"+dexscreener: {len(found)}", file=sys.stderr)
    return found


def resolve_natives(natives: list[str]) -> dict[str, tuple[str, str]]:
    chains = {c["chainId"]: c for c in get_json("https://chainid.network/chains.json")}
    found = {}
    icon_cache: dict[str, str | None] = {}
    for caip in natives:
        cid = int(caip.split(":")[1].split("/")[0])
        name = (chains.get(cid) or {}).get("icon")
        if not name:
            continue
        if name not in icon_cache:
            try:
                meta = get_json(f"https://raw.githubusercontent.com/ethereum-lists/chains/master/_data/icons/{name}.json")
                url = meta[0]["url"] if meta else None
                icon_cache[name] = url if url and url.startswith("ipfs://") else None
            except Exception:  # noqa: BLE001
                icon_cache[name] = None
        if icon_cache[name]:
            found[caip] = ("chainlist:" + name, icon_cache[name])
    print(f"chainlist: {len(found)}/{len(natives)}", file=sys.stderr)
    return found


def fetch_image(url: str) -> bytes:
    if url.startswith("ipfs://"):
        cid = url[len("ipfs://"):]
        errs = []
        for gw in IPFS_GATEWAYS:
            try:
                if gw == IPFS_GATEWAY:
                    return get(gw + cid, timeout=40, tries=3, headers=IPFS_GATEWAY_HEADERS)
                return get(gw + cid, timeout=25, tries=1)
            except Exception as e:  # noqa: BLE001
                errs.append(str(e))
        raise RuntimeError("; ".join(errs))
    return get(url)


def is_svg(raw: bytes) -> bool:
    head = raw[:2048].lstrip().lower()
    return head.startswith(b"<") and b"<svg" in head


def to_png(raw: bytes) -> bytes:
    if is_svg(raw):
        import cairosvg  # only needed for SVG sources

        raw = cairosvg.svg2png(bytestring=raw, output_width=SIZE * 2, output_height=SIZE * 2)
    im = Image.open(io.BytesIO(raw))
    im.load()
    if getattr(im, "n_frames", 1) > 1:
        im.seek(0)
    im = im.convert("RGBA")
    im.thumbnail((SIZE, SIZE), Image.LANCZOS)
    if im.size != (SIZE, SIZE):  # pad non-square logos, keep them centered
        canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        canvas.paste(im, ((SIZE - im.width) // 2, (SIZE - im.height) // 2))
        im = canvas
    # 256-colour palette with alpha: ~4x smaller than RGBA, visually identical at 128px.
    im = im.quantize(256, method=Image.Quantize.FASTOCTREE)
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def main():
    missing = json.loads((DIR / "missing.json").read_text())
    by_caip = {a["caip"]: a for a in missing}
    tokens = [c for c in by_caip if "/erc20:" in c or "/bep20:" in c]
    natives = [c for c in by_caip if c.startswith("eip155:") and "/slip44:" in c]

    sources: dict[str, tuple[str, str]] = {}
    if SOURCES_CACHE.exists() and "--refresh" not in sys.argv:
        sources = {k: tuple(v) for k, v in json.loads(SOURCES_CACHE.read_text()).items()}
        print(f"sources: {len(sources)} from cache (--refresh to re-resolve)", file=sys.stderr)
    else:
        sources.update(resolve_tokens(tokens))
        sources.update(resolve_natives(natives))
        SOURCES_CACHE.write_text(json.dumps(sources))
    for caip, url in OVERRIDES.items():
        if caip in by_caip:
            sources[caip] = ("manual", url)

    OUT.mkdir(exist_ok=True)
    manifest, failed = [], []

    def work(caip: str):
        source, url = sources[caip]
        key = by_caip[caip]["key"]
        dest = OUT / Path(key).name
        if dest.exists() and "--refresh" not in sys.argv:  # resume
            png = dest.read_bytes()
            if "--reencode" in sys.argv:
                png = to_png(png)
                dest.write_bytes(png)
        else:
            try:
                png = to_png(fetch_image(url))
            except Exception as e:  # noqa: BLE001
                if not source.startswith("chainlist:"):
                    return None, {"caip": caip, "source": source, "url": url, "error": str(e)[:300]}
                try:
                    url = LLAMA_CHAIN_ICON.format(source.split(":", 1)[1])
                    png = to_png(get(url, tries=1))
                    source += "+llama"
                except Exception:  # noqa: BLE001
                    return None, {"caip": caip, "source": source, "url": sources[caip][1], "error": str(e)[:300]}
            dest.write_bytes(png)
        return {"caip": caip, "symbol": by_caip[caip]["symbol"], "key": key, "source": source, "url": url,
                "sha256": hashlib.sha256(png).hexdigest(), "bytes": len(png)}, None

    workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 16
    with ThreadPoolExecutor(workers) as ex:
        for ok, err in ex.map(work, sorted(sources)):
            (manifest if ok else failed).append(ok or err)

    unresolved = [{"caip": c, "symbol": a["symbol"], "name": a["name"]}
                  for c, a in sorted(by_caip.items()) if c not in sources]
    (DIR / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    (DIR / "unresolved.json").write_text(json.dumps({"no_source": unresolved, "download_failed": failed}, indent=1) + "\n")
    print(f"missing={len(missing)} resolved={len(manifest)} no_source={len(unresolved)} "
          f"download_failed={len(failed)}")


if __name__ == "__main__":
    main()
