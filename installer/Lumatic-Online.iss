#include "build-info.iss"

#define AppName "Lumatic"
#define ElectronArchiveName "electron-v" + ElectronVersion + "-win32-x64.zip"
#define ElectronArchiveUrl "https://github.com/electron/electron/releases/download/v" + ElectronVersion + "/" + ElectronArchiveName

[Setup]
AppId={{A88B6A0C-7E3C-49E1-9D4C-B0D63C193817}
AppName={#AppName}
AppVersion={#LumaticVersion}
AppPublisher=Yougurton
AppPublisherURL=https://github.com/Yougurton/Lumatic
AppSupportURL=https://github.com/Yougurton/Lumatic/issues
AppUpdatesURL=https://github.com/Yougurton/Lumatic/releases
DefaultDirName={localappdata}\Programs\Lumatic
DefaultGroupName=Lumatic
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
OutputDir=..\release
OutputBaseFilename=Lumatic-Setup-{#LumaticVersion}-win-x64
SetupIconFile=..\build\icon.ico
UninstallDisplayIcon={app}\Lumatic.exe
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
Uninstallable=yes
SetupLogging=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
Source: "..\release\online-payload\resources\app.asar"; DestDir: "{app}\resources"; Flags: ignoreversion
Source: "..\release\online-payload\LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\release\online-payload\THIRD_PARTY_NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Lumatic"; Filename: "{app}\Lumatic.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Lumatic"; Filename: "{app}\Lumatic.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Lumatic.exe"; Description: "Launch Lumatic"; WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
const
  ElectronUrl = '{#ElectronArchiveUrl}';
  ElectronArchive = '{#ElectronArchiveName}';
  ElectronSha256 = '{#ElectronSha256}';

var
  DownloadPage: TDownloadWizardPage;
  RuntimeFolder: String;

function OnDownloadProgress(const Url, FileName: String; const Progress, ProgressMax: Int64): Boolean;
begin
  Result := True;
end;

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage(
    SetupMessage(msgWizardPreparing),
    'Lumatic downloads the official Electron runtime directly from the Electron project. The downloaded archive is checked against its published SHA-256 checksum.',
    @OnDownloadProgress);
  DownloadPage.ShowBaseNameInsteadOfURL := True;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  RuntimeZip: String;
begin
  Result := '';
  RuntimeZip := ExpandConstant('{tmp}\' + ElectronArchive);
  RuntimeFolder := ExpandConstant('{tmp}\Lumatic-Electron-Runtime');

  try
    DownloadPage.Clear;
    DownloadPage.Add(ElectronUrl, ElectronArchive, ElectronSha256);
    DownloadPage.Show;
    try
      DownloadPage.Download;
    finally
      DownloadPage.Hide;
    end;

    if DirExists(RuntimeFolder) then
      DelTree(RuntimeFolder, True, True, True);
    ForceDirectories(RuntimeFolder);
    ExtractArchive(RuntimeZip, RuntimeFolder, '', True, nil);

    if not FileExists(RuntimeFolder + '\electron.exe') then
      RaiseException('The downloaded Electron archive does not contain electron.exe.');
    if not FileExists(RuntimeFolder + '\LICENSE') then
      RaiseException('The Electron license file is missing from the downloaded archive.');
    if not FileExists(RuntimeFolder + '\LICENSES.chromium.html') then
      RaiseException('The Chromium third-party license notices are missing from the downloaded archive.');
  except
    Result := GetExceptionMessage;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  AppFolder: String;
  CopyResult: Integer;
  CopyOk: Boolean;
begin
  if CurStep = ssPostInstall then
  begin
    AppFolder := ExpandConstant('{app}');

    CopyOk := Exec(
      ExpandConstant('{sys}\robocopy.exe'),
      '"' + RuntimeFolder + '" "' + AppFolder + '" /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP',
      AppFolder,
      SW_HIDE,
      ewWaitUntilTerminated,
      CopyResult);

    if (not CopyOk) or (CopyResult >= 8) then
      RaiseException('Could not install the Electron runtime. Robocopy exit code: ' + IntToStr(CopyResult));

    if not RenameFile(AppFolder + '\electron.exe', AppFolder + '\Lumatic.exe') then
      RaiseException('Could not rename electron.exe to Lumatic.exe.');

    if not RenameFile(AppFolder + '\LICENSE', AppFolder + '\LICENSE.electron.txt') then
      RaiseException('Could not preserve the Electron license file.');

    if not FileExists(AppFolder + '\LICENSES.chromium.html') then
      RaiseException('The Chromium license notices were not installed.');

    DeleteFile(AppFolder + '\resources\default_app.asar');
  end;
end;
