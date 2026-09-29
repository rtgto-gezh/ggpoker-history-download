# build.py
# 打包 Chrome 扩展 zip。
#
# 不要用 PowerShell 的 Compress-Archive：Windows PowerShell 5.1 会把子目录条目写成
# "icons\icon16.png"（反斜杠），而 zip 规范要求正斜杠，Chrome 解包后会找不到
# icons/ 和 sidepanel/ 下的文件。这里用 zipfile 显式指定 arcname。
#
#   python tools/build.py      -> 输出到仓库根 gg-download-<version>.zip

import json
import os
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
# 扩展本体在 extension/，加载顺序与路径引用见 extension/README.md
SRC = os.path.join(REPO, "extension")
EXCLUDE_DIRS = {".vscode", ".git", "node_modules", "__pycache__"}
EXCLUDE_FILES = {"README.md", ".gitignore", ".DS_Store",
                 # 每次打包现生成，见 make_build_info
                 "build-info.json",
                 # 给服务端参考用的规则模板，运行时不需要打进包里
                 "pokercraft-rules.sample.json"}


def make_build_info(version):
    """版本号测试期间固定不变，所以另给一个构建编号（打包时间，越新越大）。
    实时GTO 用它判断用户装的扩展是不是旧的：扩展报上自己的编号，
    和实时GTO 内置的那份比，小了就提示更新。"""
    import datetime
    commit = ""
    try:
        commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=SRC,
                                capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        pass
    return {
        "version": version,
        "build": int(datetime.datetime.now().strftime("%Y%m%d%H%M")),
        "commit": commit,
    }


def collect(src):
    entries = []
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for name in sorted(files):
            if name in EXCLUDE_FILES:
                continue
            full = os.path.join(root, name)
            arc = os.path.relpath(full, src).replace(os.sep, "/")
            entries.append((full, arc))
    return entries


def verify(zip_path, manifest):
    """打完包自检：manifest 引用到的文件必须都在包里，且路径分隔符正确。"""
    with zipfile.ZipFile(zip_path) as z:
        names = set(z.namelist())

    backslashed = [n for n in names if chr(92) in n]
    if backslashed:
        raise SystemExit("包内存在反斜杠路径，Chrome 无法读取: %s" % backslashed)

    required = ["manifest.json"]
    required += list(manifest.get("icons", {}).values())
    required += list(manifest.get("action", {}).get("default_icon", {}).values())
    if "background" in manifest:
        required.append(manifest["background"]["service_worker"])
    for cs in manifest.get("content_scripts", []):
        required += cs.get("js", [])
        required += cs.get("css", [])
    if "side_panel" in manifest:
        required.append(manifest["side_panel"]["default_path"])

    missing = sorted({r for r in required if r not in names})
    if missing:
        raise SystemExit("manifest 引用的文件不在包里: %s" % missing)
    return names


def run_check(script_name, label):
    """打包前的静态检查。node 不在就跳过（不算失败），脚本报错则中止打包。"""
    node = shutil.which("node")
    script = os.path.join(HERE, script_name)
    if not node or not os.path.exists(script):
        print("警告：未找到 node 或 tools/%s，跳过%s" % (script_name, label))
        return
    r = subprocess.run([node, script], cwd=HERE)
    if r.returncode != 0:
        raise SystemExit("%s未通过，已中止打包" % label)


def check_api():
    """打包前跑静态检查：调用了不存在的函数、加载清单走神，都不许打包。"""
    run_check("check_api.js", "接口检查")
    run_check("check_load_order.js", "加载顺序检查")


def main():
    check_api()
    manifest_path = os.path.join(SRC, "manifest.json")
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)

    version = manifest["version"]
    out = os.path.join(os.path.dirname(SRC), "gg-download-%s.zip" % version)

    entries = collect(SRC)
    build_info = make_build_info(version)
    # 源码目录也放一份（已在 .gitignore），开发时直接加载源码目录也有构建编号
    with open(os.path.join(SRC, "build-info.json"), "w", encoding="utf-8") as f:
        json.dump(build_info, f, ensure_ascii=False, indent=2)
    if os.path.exists(out):
        os.remove(out)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for full, arc in entries:
            z.write(full, arc)
        z.writestr("build-info.json", json.dumps(build_info, ensure_ascii=False, indent=2))
    print("构建编号: %s（%s）" % (build_info["build"], build_info.get("commit") or "-"))

    names = verify(out, manifest)

    print("输出: %s (%d bytes)" % (out, os.path.getsize(out)))
    print("版本: %s  文件数: %d" % (version, len(names)))
    for n in sorted(names):
        print("   ", n)
    print("自检通过：路径分隔符正确，manifest 引用的文件齐全")

    # 实时GTO 内置了一份扩展（「GG数据导入」→「安装GG数据下载扩展」解压出来给用户加载）。
    # python build.py --copy-to <实时GTO 仓库>/assets/gg_extension 会把这次打的包放进去，
    # 固定文件名，实时GTO 那边不用跟着改版本号。
    if "--copy-to" in sys.argv:
        i = sys.argv.index("--copy-to")
        if i + 1 >= len(sys.argv):
            print("--copy-to 后面要跟目录")
            return 1
        dest_dir = sys.argv[i + 1]
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, "gg-download-extension.zip")
        shutil.copyfile(out, dest)
        print("已复制到: %s" % dest)


if __name__ == "__main__":
    sys.exit(main())
