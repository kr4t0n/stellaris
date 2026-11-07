"""Probe only: compiles the icon's manifest in three shapes and draws each in iOS's six appearances."""
import copy, json, os, shutil, subprocess, sys

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
ictool = os.path.join(os.environ["DEVELOPER_DIR"], "..", "Applications", "Icon Composer.app", "Contents",
                      "Executables", "ictool")
doc = json.load(open(os.path.join(src, "icon.json")))

def old_shape(d):
    """The manifest as 0be9e55 had it: a top-level fill beside the specializations, and fill on each layer."""
    d = copy.deepcopy(d)
    specs = d.pop("fill-specializations")
    d["fill"] = specs[0]["value"]
    d["fill-specializations"] = specs[1:] + [{"appearance": "tinted", "value": "automatic"}]
    for g in d["groups"]:
        for layer in g["layers"]:
            layer["fill"] = "automatic"
    return d

def no_layer_tint(d):
    d = copy.deepcopy(d)
    for g in d["groups"]:
        for layer in g["layers"]:
            layer.pop("fill-specializations", None)
    return d

variants = {"shape": None, "old-shape": old_shape(doc), "shape-no-layer-tint": no_layer_tint(doc)}
for name, d in variants.items():
    base = os.path.join(out, name)
    icon = os.path.join(base, "AppIcon.icon")
    shutil.copytree(src, icon)
    if d is not None:  # "shape" keeps the file byte for byte
        json.dump(d, open(os.path.join(icon, "icon.json"), "w"), indent=2)
    compiled = os.path.join(base, "compiled")
    os.makedirs(compiled)
    r = subprocess.run(["xcrun", "actool", icon, "--compile", compiled, "--output-format", "human-readable-text",
                        "--errors", "--warnings", "--notices", "--app-icon", "AppIcon",
                        "--output-partial-info-plist", os.path.join(base, "partial.plist"),
                        "--target-device", "iphone", "--minimum-deployment-target", "27.0",
                        "--platform", "iphonesimulator"], capture_output=True, text=True)
    print(f"=== {name}: actool rc={r.returncode}\n{r.stdout}\n{r.stderr}", flush=True)
    for rendition in ["Default", "Dark", "ClearLight", "ClearDark", "TintedLight", "TintedDark"]:
        dest = os.path.join(out, f"{name}-{rendition}.png")
        p = subprocess.run([ictool, icon, "--export-image", "--output-file", dest, "--platform", "iOS",
                            "--rendition", rendition, "--width", "1024", "--height", "1024", "--scale", "1"],
                           capture_output=True, text=True)
        print(f"ictool {name} {rendition}: rc={p.returncode} {p.stdout.strip()[:300]} {p.stderr.strip()[:300]}",
              flush=True)
