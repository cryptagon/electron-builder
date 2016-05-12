import { downloadCertificate } from "./codeSign"
import { Promise as BluebirdPromise } from "bluebird"
import { PlatformPackager, BuildInfo } from "./platformPackager"
import { Platform, WinBuildOptions } from "./metadata"
import * as path from "path"
import { log, statOrNull } from "./util"
import { readFile, deleteFile, rename, copy, emptyDir, writeFile, open, close, read, move } from "fs-extra-p"
import { sign } from "signcode-tf"
import ElectronPackagerOptions = ElectronPackager.ElectronPackagerOptions

//noinspection JSUnusedLocalSymbols
const __awaiter = require("./awaiter")

export class WinPackager extends PlatformPackager<WinBuildOptions> {
  certFilePromise: Promise<string | null>

  loadingGifStat: Promise<string> | null

  readonly iconPath: Promise<string>

  constructor(info: BuildInfo, cleanupTasks: Array<() => Promise<any>>) {
    super(info)

    if (this.options.cscLink != null && this.options.cscKeyPassword != null) {
      this.certFilePromise = downloadCertificate(this.options.cscLink)
        .then(path => {
          cleanupTasks.push(() => deleteFile(path, true))
          return path
        })
    }
    else {
      this.certFilePromise = BluebirdPromise.resolve(null)
    }

    this.iconPath = this.getValidIconPath()

    if (this.options.dist && this.customBuildOptions.loadingGif == null) {
      const installSpinnerPath = path.join(this.buildResourcesDir, "install-spinner.gif")
      this.loadingGifStat = statOrNull(installSpinnerPath)
        .then(it => it != null && !it.isDirectory() ? installSpinnerPath : null)
    }
  }

  get platform() {
    return Platform.WINDOWS
  }

  private async getValidIconPath(): Promise<string> {
    const iconPath = path.join(this.buildResourcesDir, "icon.ico")
    await checkIcon(iconPath)
    return iconPath
  }

  async pack(outDir: string, arch: string, postAsyncTasks: Array<Promise<any>>): Promise<any> {
    // we must check icon before pack because electron-packager uses icon and it leads to cryptic error message "spawn wine ENOENT"
    await this.iconPath

    let appOutDir = this.computeAppOutDir(outDir, arch)
    const packOptions = this.computePackOptions(outDir, arch)

    if (!this.options.dist) {
      await this.doPack(packOptions, outDir, appOutDir, arch, this.customBuildOptions)
      return
    }

    const unpackedDir = path.join(outDir, `win${arch === "x64" ? "" : `-${arch}`}-unpacked`)
    const finalAppOut = path.join(outDir, `win${arch === "x64" ? "" : `-${arch}`}-unpacked`, "lib", "net45")
    const installerOut = computeDistOut(outDir, arch)
    log("Removing %s and %s", path.relative(this.projectDir, installerOut), path.relative(this.projectDir, unpackedDir))
    await BluebirdPromise.all([
      this.packApp(packOptions, appOutDir),
      emptyDir(installerOut),
      emptyDir(unpackedDir)
    ])

    await move(appOutDir, finalAppOut)
    appOutDir = finalAppOut

    await this.copyExtraResources(appOutDir, arch, this.customBuildOptions)
    if (this.options.dist) {
      postAsyncTasks.push(this.packageInDistributableFormat(outDir, appOutDir, arch, packOptions))
    }
  }

  protected async packApp(options: any, appOutDir: string) {
    await super.packApp(options, appOutDir)

    if (process.platform !== "linux" && this.options.cscLink != null && this.options.cscKeyPassword != null) {
      const filename = this.appName + ".exe"
      log(`Signing ${filename}`)
      await BluebirdPromise.promisify(sign)({
        path: path.join(appOutDir, filename),
        cert: (await this.certFilePromise)!,
        password: this.options.cscKeyPassword,
        name: this.appName,
        site: await this.computePackageUrl(),
        overwrite: true,
      })
    }
  }

  protected async computeEffectiveDistOptions(appOutDir: string, installerOutDir: string, packOptions: ElectronPackagerOptions): Promise<any> {
    let iconUrl = this.customBuildOptions.iconUrl || this.devMetadata.build.iconUrl
    if (iconUrl == null) {
      if (this.info.repositoryInfo != null) {
        const info = await this.info.repositoryInfo.getInfo(this)
        if (info != null) {
          iconUrl = `https://github.com/${info.user}/${info.project}/blob/master/${this.relativeBuildResourcesDirname}/icon.ico?raw=true`
        }
      }

      if (iconUrl == null) {
        throw new Error("iconUrl is not specified, please see https://github.com/electron-userland/electron-builder/wiki/Options#WinBuildOptions-iconUrl")
      }
    }

    checkConflictingOptions(this.customBuildOptions)

    const projectUrl = await this.computePackageUrl()
    const rceditOptions = {
      "version-string": packOptions["version-string"],
      "file-version": packOptions["build-version"],
      "product-version": packOptions["app-version"],
    }
    rceditOptions["version-string"]!.LegalCopyright = packOptions["app-copyright"]

    const options: any = Object.assign({
      name: this.metadata.name,
      productName: this.appName,
      exe: this.appName + ".exe",
      title: this.appName,
      appDirectory: appOutDir,
      outputDirectory: installerOutDir,
      version: this.metadata.version,
      description: this.metadata.description,
      authors: this.metadata.author.name,
      iconUrl: iconUrl,
      setupIcon: await this.iconPath,
      certificateFile: await this.certFilePromise,
      certificatePassword: this.options.cscKeyPassword,
      fixUpPaths: false,
      skipUpdateIcon: true,
      usePackageJson: false,
      noMsi: true,
      extraMetadataSpecs: projectUrl == null ? null : `\n    <projectUrl>${projectUrl}</projectUrl>`,
      copyright: packOptions["app-copyright"],
      sign: {
        name: this.appName,
        site: projectUrl,
        overwrite: true,
      },
      rcedit: rceditOptions,
    }, this.customBuildOptions)

    if (this.loadingGifStat != null) {
      options.loadingGif = await this.loadingGifStat
    }

    return options
  }

  async packageInDistributableFormat(outDir: string, appOutDir: string, arch: string, packOptions: ElectronPackagerOptions): Promise<any> {
    const installerOutDir = computeDistOut(outDir, arch)
    await require("electron-winstaller-fixed").createWindowsInstaller(await this.computeEffectiveDistOptions(appOutDir, installerOutDir, packOptions))

    const version = this.metadata.version
    const archSuffix = arch === "x64" ? "" : ("-" + arch)
    const releasesFile = path.join(installerOutDir, "RELEASES")
    const nupkgPathOriginal = this.metadata.name + "-" + version + "-full.nupkg"
    const nupkgPathWithArch = this.metadata.name + "-" + version + archSuffix + "-full.nupkg"

    async function changeFileNameInTheReleasesFile(): Promise<void> {
      const data = (await readFile(releasesFile, "utf8")).replace(new RegExp(" " + nupkgPathOriginal + " ", "g"), " " + nupkgPathWithArch + " ")
      await writeFile(releasesFile, data)
    }

    const promises: Array<Promise<any>> = [
      rename(path.join(installerOutDir, "Setup.exe"), path.join(installerOutDir, `${this.appName} Setup ${version}${archSuffix}.exe`))
        .then(it => this.dispatchArtifactCreated(it, `${this.metadata.name}-Setup-${version}${archSuffix}.exe`)),
    ]

    if (archSuffix === "") {
      this.dispatchArtifactCreated(path.join(installerOutDir, nupkgPathOriginal))
      this.dispatchArtifactCreated(path.join(installerOutDir, "RELEASES"))
    }
    else {
      promises.push(
        rename(path.join(installerOutDir, nupkgPathOriginal), path.join(installerOutDir, nupkgPathWithArch))
          .then(it => this.dispatchArtifactCreated(it))
      )
      promises.push(
        changeFileNameInTheReleasesFile()
          .then(() => copy(releasesFile, path.join(installerOutDir, "RELEASES-ia32")))
          .then(it => this.dispatchArtifactCreated(it))
      )
    }

    await BluebirdPromise.all(promises)
  }
}

async function checkIcon(file: string): Promise<void> {
  const fd = await open(file, "r")
  const buffer = new Buffer(512)
  try {
    await read(fd, buffer, 0, buffer.length, 0)
  }
  finally {
    await close(fd)
  }

  if (!isIco(buffer)) {
    throw new Error(`Windows icon is not valid ico file, please fix "${file}"`)
  }

  const sizes = parseIco(buffer)
  for (let size of sizes) {
    if (size!.w >= 256 && size!.h >= 256) {
      return
    }
  }

  throw new Error(`Windows icon size must be at least 256x256, please fix "${file}"`)
}

interface Size {
  w: number
  h: number
}

function parseIco(buffer: Buffer): Array<Size> {
  if (!isIco(buffer)) {
    throw new Error("buffer is not ico")
  }

  const n = buffer.readUInt16LE(4)
  const result = new Array<Size>(n)
  for (let i = 0; i < n; i++) {
    result[i] = {
      w: buffer.readUInt8(6 + i * 16) || 256,
      h: buffer.readUInt8(7 + i * 16) || 256,
    }
  }
  return result
}

function isIco(buffer: Buffer): boolean {
  return buffer.readUInt16LE(0) === 0 && buffer.readUInt16LE(2) === 1
}

export function computeDistOut(outDir: string, arch: string): string {
  return path.join(outDir, "win" + (arch === "x64" ? "" : "-arch"))
}

function checkConflictingOptions(options: any) {
  for (let name of ["outputDirectory", "appDirectory", "exe", "fixUpPaths", "usePackageJson", "extraFileSpecs", "extraMetadataSpecs", "skipUpdateIcon", "setupExe"]) {
    if (name! in options) {
      throw new Error(`Option ${name} is ignored, do not specify it.`)
    }
  }

  const noMsi = options.noMsi
  if (noMsi != null && typeof noMsi !== "boolean") {
    throw new Error(`noMsi expected to be boolean value, but string '"${noMsi}"' was specified`)
  }
}