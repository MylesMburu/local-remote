#Requires -Version 5.1
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue | Out-Null
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.Buffer, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Foundation.AsyncStatus, Windows.Foundation, ContentType = WindowsRuntime]

$audioType = @"
using System;
using System.Runtime.InteropServices;

public static class LocalRemoteAudio {
  [DllImport("ole32.dll")]
  private static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint ctx, ref Guid iid, out IntPtr ppv);

  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  private delegate int GetDefaultDel(IntPtr self, int dataFlow, int role, out IntPtr device);

  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  private delegate int ActivateDel(IntPtr self, ref Guid iid, int clsctx, IntPtr unused, out IntPtr ppv);

  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  private delegate int GetVolDel(IntPtr self, out float level);

  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  private delegate int SetVolDel(IntPtr self, float level, IntPtr eventCtx);

  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  private delegate int GetMuteDel(IntPtr self, out int mute);

  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  private delegate int SetMuteDel(IntPtr self, int mute, IntPtr eventCtx);

  private static IntPtr Slot(IntPtr obj, int index) {
    IntPtr vtbl = Marshal.ReadIntPtr(obj);
    return Marshal.ReadIntPtr(vtbl, index * IntPtr.Size);
  }

  private static IntPtr VolumePtr() {
    Guid clsid = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    Guid iidEn = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
    IntPtr en;
    Marshal.ThrowExceptionForHR(CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iidEn, out en));
    try {
      var getDefault = Marshal.GetDelegateForFunctionPointer<GetDefaultDel>(Slot(en, 4));
      IntPtr dev;
      Marshal.ThrowExceptionForHR(getDefault(en, 0, 1, out dev));
      try {
        Guid iidVol = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        var activate = Marshal.GetDelegateForFunctionPointer<ActivateDel>(Slot(dev, 3));
        IntPtr vol;
        Marshal.ThrowExceptionForHR(activate(dev, ref iidVol, 1, IntPtr.Zero, out vol));
        return vol;
      } finally {
        Marshal.Release(dev);
      }
    } finally {
      Marshal.Release(en);
    }
  }

  public static int GetVolume() {
    IntPtr vol = VolumePtr();
    try {
      float v;
      var fn = Marshal.GetDelegateForFunctionPointer<GetVolDel>(Slot(vol, 9));
      Marshal.ThrowExceptionForHR(fn(vol, out v));
      return (int)Math.Round(v * 100.0);
    } finally {
      Marshal.Release(vol);
    }
  }

  public static void SetVolume(int percent) {
    IntPtr vol = VolumePtr();
    try {
      float v = Math.Max(0, Math.Min(100, percent)) / 100f;
      var fn = Marshal.GetDelegateForFunctionPointer<SetVolDel>(Slot(vol, 7));
      Marshal.ThrowExceptionForHR(fn(vol, v, IntPtr.Zero));
    } finally {
      Marshal.Release(vol);
    }
  }

  public static bool GetMute() {
    IntPtr vol = VolumePtr();
    try {
      int m;
      var fn = Marshal.GetDelegateForFunctionPointer<GetMuteDel>(Slot(vol, 15));
      Marshal.ThrowExceptionForHR(fn(vol, out m));
      return m != 0;
    } finally {
      Marshal.Release(vol);
    }
  }

  public static void SetMute(bool mute) {
    IntPtr vol = VolumePtr();
    try {
      var fn = Marshal.GetDelegateForFunctionPointer<SetMuteDel>(Slot(vol, 14));
      Marshal.ThrowExceptionForHR(fn(vol, mute ? 1 : 0, IntPtr.Zero));
    } finally {
      Marshal.Release(vol);
    }
  }
}
"@

$keyType = @"
using System;
using System.Runtime.InteropServices;

public static class LocalRemoteKeys {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

  [DllImport("user32.dll")]
  public static extern int SendMessage(int hWnd, int hMsg, int wParam, int lParam);

  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;

  public static void Tap(byte vk, bool extended) {
    uint down = extended ? KEYEVENTF_EXTENDEDKEY : 0;
    uint up = down | KEYEVENTF_KEYUP;
    keybd_event(vk, 0, down, UIntPtr.Zero);
    keybd_event(vk, 0, up, UIntPtr.Zero);
  }

  public static void Chord(byte[] downs, byte[] ups) {
    foreach (var vk in downs) { keybd_event(vk, 0, 0, UIntPtr.Zero); }
    foreach (var vk in ups) { keybd_event(vk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero); }
  }

  public static void ScreensOff() {
    SendMessage(-1, 0x0112, 0xF170, 2);
  }
}
"@

try { Add-Type -TypeDefinition $audioType -Language CSharp | Out-Null } catch { [Console]::Error.WriteLine("audio type: $($_.Exception.Message)") }
try { Add-Type -TypeDefinition $keyType -Language CSharp | Out-Null } catch { [Console]::Error.WriteLine("key type: $($_.Exception.Message)") }

$asTaskGeneric = $null
try {
  $asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq "AsTask" -and
      $_.IsGenericMethodDefinition -and
      $_.GetParameters().Count -eq 1
    } |
    Select-Object -First 1
} catch {}

function Await-WinRT {
  param($Async, [Type]$ResultType)
  if ($null -eq $Async) { return $null }
  if ($null -ne $asTaskGeneric) {
    $task = $asTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($Async))
    $null = $task.Wait(-1)
    return $task.Result
  }
  return $Async.GetAwaiter().GetResult()
}

function Get-MediaManager {
  return Await-WinRT ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
}

function Get-FriendlyApp([string]$appId) {
  if ([string]::IsNullOrWhiteSpace($appId)) { return "App" }
  $lower = $appId.ToLowerInvariant()
  if ($lower -match "spotify") { return "Spotify" }
  if ($lower -match "youtube") { return "YouTube" }
  if ($lower -match "msedge" -or $lower -match "edge") { return "Edge" }
  if ($lower -match "chrome") { return "Chrome" }
  if ($lower -match "firefox") { return "Firefox" }
  if ($lower -match "vlc") { return "VLC" }
  if ($lower -match "itunes" -or $lower -match "applemusic") { return "Apple Music" }
  if ($lower -match "wmplayer" -or $lower -match "zune") { return "Groove" }
  if ($lower -match "discord") { return "Discord" }
  $tail = ($appId -split "[\\.!]")[-1]
  if ([string]::IsNullOrWhiteSpace($tail)) { return $appId }
  return $tail
}

function Convert-Status($status) {
  if ($null -eq $status) { return "Unknown" }
  switch ($status.ToString()) {
    "Playing" { "Playing" }
    "Paused" { "Paused" }
    "Stopped" { "Stopped" }
    "Changing" { "Changing" }
    "Closed" { "Closed" }
    "Opened" { "Opened" }
    default { "Unknown" }
  }
}

function Await-Status($op) {
  if ($null -eq $op) { return $null }
  $guard = 0
  while ($op.Status -eq [Windows.Foundation.AsyncStatus]::Started -and $guard -lt 200) {
    Start-Sleep -Milliseconds 10
    $guard++
  }
  if ($op.Status -ne [Windows.Foundation.AsyncStatus]::Completed) { return $null }
  return $op.GetResults()
}

function Get-Artwork($props) {
  try {
    if ($null -eq $props -or $null -eq $props.Thumbnail) { return $null }
    $stream = Await-Status $props.Thumbnail.OpenReadAsync()
    if ($null -eq $stream) { return $null }
    $size = [uint32]$stream.Size
    if ($size -eq 0 -or $size -gt 1500000) { return $null }
    $buffer = [Windows.Storage.Streams.Buffer]::new($size)
    $null = Await-Status ($stream.ReadAsync($buffer, $size, [Windows.Storage.Streams.InputStreamOptions]::None))
    $bytes = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::ToArray($buffer)
    $ct = $stream.ContentType
    if ([string]::IsNullOrWhiteSpace($ct)) { $ct = "image/jpeg" }
    $stream.Dispose()
    return "data:$ct;base64," + [Convert]::ToBase64String($bytes)
  } catch {
    [Console]::Error.WriteLine("artwork: $($_.Exception.Message)")
    return $null
  }
}

$script:artCache = @{}

function Get-SessionId($session, $title, $artist) {
  $appId = ""
  try { $appId = [string]$session.SourceAppUserModelId } catch {}
  return "$appId|$title|$artist"
}

function Read-Sessions($wantArt) {
  $list = @()
  try {
    $mgr = Get-MediaManager
    if ($null -eq $mgr) { return @() }
    foreach ($session in $mgr.GetSessions()) {
      try {
        $props = Await-WinRT $session.TryGetMediaPropertiesAsync() ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $title = ""
        $artist = ""
        $album = ""
        if ($null -ne $props) {
          $title = [string]$props.Title
          $artist = [string]$props.Artist
          $album = [string]$props.AlbumTitle
        }
        $appId = ""
        try { $appId = [string]$session.SourceAppUserModelId } catch {}
        $info = $session.GetPlaybackInfo()
        $timeline = $session.GetTimelineProperties()
        $status = "Unknown"
        $canPlay = $false
        $canPause = $false
        $canNext = $false
        $canPrev = $false
        if ($null -ne $info) {
          $status = Convert-Status $info.PlaybackStatus
          try {
            $cs = $info.Controls
            if ($null -ne $cs) {
              $canPlay = [bool]$cs.IsPlayEnabled
              $canPause = [bool]$cs.IsPauseEnabled
              $canNext = [bool]$cs.IsNextEnabled
              $canPrev = [bool]$cs.IsPreviousEnabled
            }
          } catch {}
        }
        $pos = 0
        $dur = 0
        if ($null -ne $timeline) {
          try { $pos = [int]$timeline.Position.TotalMilliseconds } catch {}
          try { $dur = [int]$timeline.EndTime.TotalMilliseconds } catch {}
        }
        $id = Get-SessionId $session $title $artist
        $art = $null
        if ($wantArt -and -not $script:artCache.ContainsKey($id)) {
          $art = Get-Artwork $props
          $script:artCache[$id] = $true
        }
        $list += @{
          id = $id
          app = Get-FriendlyApp $appId
          appId = $appId
          title = $title
          artist = $artist
          album = $album
          status = $status
          positionMs = $pos
          durationMs = $dur
          canPlay = $canPlay
          canPause = $canPause
          canSkipNext = $canNext
          canSkipPrevious = $canPrev
          artwork = $art
        }
      } catch {}
    }
  } catch {}
  return $list
}

function Find-Session([string]$id) {
  try {
    $mgr = Get-MediaManager
    if ($null -eq $mgr) { return $null }
    if ([string]::IsNullOrWhiteSpace($id)) {
      return $mgr.GetCurrentSession()
    }
    foreach ($session in $mgr.GetSessions()) {
      try {
        $props = Await-WinRT $session.TryGetMediaPropertiesAsync() ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $title = ""; $artist = ""
        if ($null -ne $props) {
          $title = [string]$props.Title
          $artist = [string]$props.Artist
        }
        if ((Get-SessionId $session $title $artist) -eq $id) { return $session }
      } catch {}
    }
    return $mgr.GetCurrentSession()
  } catch {
    return $null
  }
}

function Invoke-MediaBool($op) {
  try { $null = Await-WinRT $op ([bool]) } catch {}
}

function Send-MediaKey([byte]$vk) {
  try { [LocalRemoteKeys]::Tap($vk, $true) } catch {}
}

function Invoke-Toggle([string]$id) {
  $session = Find-Session $id
  if ($null -ne $session) { Invoke-MediaBool $session.TryTogglePlayPauseAsync(); return }
  Send-MediaKey 0xB3
}

function Invoke-Play([string]$id) {
  $session = Find-Session $id
  if ($null -ne $session) { Invoke-MediaBool $session.TryPlayAsync(); return }
  Send-MediaKey 0xB3
}

function Invoke-Pause([string]$id) {
  $session = Find-Session $id
  if ($null -ne $session) { Invoke-MediaBool $session.TryPauseAsync(); return }
  Send-MediaKey 0xB3
}

function Invoke-Next([string]$id) {
  $session = Find-Session $id
  if ($null -ne $session) { Invoke-MediaBool $session.TrySkipNextAsync(); return }
  Send-MediaKey 0xB0
}

function Invoke-Previous([string]$id) {
  $session = Find-Session $id
  if ($null -ne $session) { Invoke-MediaBool $session.TrySkipPreviousAsync(); return }
  Send-MediaKey 0xB1
}

function Invoke-Seek([string]$id, [int]$positionMs) {
  $session = Find-Session $id
  if ($null -eq $session) { return }
  $ticks = [int64]$positionMs * 10000L
  try { Invoke-MediaBool $session.TryChangePlaybackPositionAsync($ticks) } catch {}
}

function Send-NamedKeys([string]$keys) {
  $name = $keys.ToLowerInvariant()
  $VK_SHIFT = [byte]0x10
  $VK_CONTROL = [byte]0x11
  $VK_MENU = [byte]0x12
  $VK_LWIN = [byte]0x5B
  $VK_SPACE = [byte]0x20
  $VK_LEFT = [byte]0x25
  $VK_UP = [byte]0x26
  $VK_RIGHT = [byte]0x27
  $VK_DOWN = [byte]0x28
  $VK_ESCAPE = [byte]0x1B

  function Letter([char]$ch) {
    return [byte][char]::ToUpperInvariant($ch)
  }

  switch ($name) {
    "playpause" { Send-MediaKey 0xB3; return }
    "nexttrack" { Send-MediaKey 0xB0; return }
    "prevtrack" { Send-MediaKey 0xB1; return }
    "volup" { [LocalRemoteKeys]::Tap(0xAF, $true); return }
    "voldown" { [LocalRemoteKeys]::Tap(0xAE, $true); return }
    "volmute" { [LocalRemoteKeys]::Tap(0xAD, $true); return }
    "space" { [LocalRemoteKeys]::Tap($VK_SPACE, $false); return }
    "k" { [LocalRemoteKeys]::Tap((Letter 'k'), $false); return }
    "j" { [LocalRemoteKeys]::Tap((Letter 'j'), $false); return }
    "l" { [LocalRemoteKeys]::Tap((Letter 'l'), $false); return }
    "f" { [LocalRemoteKeys]::Tap((Letter 'f'), $false); return }
    "m" { [LocalRemoteKeys]::Tap((Letter 'm'), $false); return }
    "c" { [LocalRemoteKeys]::Tap((Letter 'c'), $false); return }
    "t" { [LocalRemoteKeys]::Tap((Letter 't'), $false); return }
    "left" { [LocalRemoteKeys]::Tap($VK_LEFT, $true); return }
    "right" { [LocalRemoteKeys]::Tap($VK_RIGHT, $true); return }
    "up" { [LocalRemoteKeys]::Tap($VK_UP, $true); return }
    "down" { [LocalRemoteKeys]::Tap($VK_DOWN, $true); return }
    "esc" { [LocalRemoteKeys]::Tap($VK_ESCAPE, $false); return }
    "shift+n" {
      [LocalRemoteKeys]::Chord(@($VK_SHIFT, (Letter 'n')), @((Letter 'n'), $VK_SHIFT))
      return
    }
    "shift+p" {
      [LocalRemoteKeys]::Chord(@($VK_SHIFT, (Letter 'p')), @((Letter 'p'), $VK_SHIFT))
      return
    }
    "alt+left" {
      [LocalRemoteKeys]::keybd_event($VK_MENU, 0, 0, [UIntPtr]::Zero)
      [LocalRemoteKeys]::Tap($VK_LEFT, $true)
      [LocalRemoteKeys]::keybd_event($VK_MENU, 0, 2, [UIntPtr]::Zero)
      return
    }
    default { return }
  }
}

function Get-VolumeState {
  $vol = 0
  $muted = $false
  try { $vol = [LocalRemoteAudio]::GetVolume() } catch {}
  try { $muted = [LocalRemoteAudio]::GetMute() } catch {}
  return @{ volume = $vol; muted = $muted }
}

$script:brightnessOk = $true
$script:cachedBright = $null

function Get-Brightness {
  if (-not $script:brightnessOk) { return $null }
  if ($null -ne $script:cachedBright) { return $script:cachedBright }
  try {
    $b = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1
    if ($null -eq $b) { $script:brightnessOk = $false; return $null }
    $script:cachedBright = [int]$b.CurrentBrightness
    return $script:cachedBright
  } catch {
    $script:brightnessOk = $false
    return $null
  }
}

function Set-BrightnessLevel([int]$level) {
  $level = [Math]::Max(0, [Math]::Min(100, $level))
  Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop |
    Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = $level } | Out-Null
  $script:cachedBright = $level
}

function Write-State {
  $wantArt = $true
  $sessions = @(Read-Sessions $wantArt)
  $vol = Get-VolumeState
  $activeId = $null
  foreach ($s in $sessions) {
    if ($s.status -eq "Playing") { $activeId = $s.id; break }
  }
  if ($null -eq $activeId -and $sessions.Count -gt 0) { $activeId = $sessions[0].id }
  $live = @{}
  foreach ($s in $sessions) { $live[$s.id] = $true }
  foreach ($k in @($script:artCache.Keys)) {
    if (-not $live.ContainsKey($k)) { $script:artCache.Remove($k) }
  }
  $state = @{
    volume = $vol.volume
    muted = $vol.muted
    brightness = (Get-Brightness)
    sessions = $sessions
    activeId = $activeId
  }
  $json = $state | ConvertTo-Json -Compress -Depth 8
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Write-ErrorState([string]$message) {
  $obj = @{
    volume = 0
    muted = $false
    brightness = $null
    sessions = @()
    activeId = $null
    error = $message
  }
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  try {
    $cmd = $line | ConvertFrom-Json
    $action = [string]$cmd.action
    $id = $null
    try { $id = [string]$cmd.id } catch {}
    if ($id -eq "") { $id = $null }

    switch ($action) {
      "tick" { }
      "toggle" { Invoke-Toggle $id }
      "play" { Invoke-Play $id }
      "pause" { Invoke-Pause $id }
      "next" { Invoke-Next $id }
      "previous" { Invoke-Previous $id }
      "seek" { Invoke-Seek $id ([int]$cmd.positionMs) }
      "volume" { [LocalRemoteAudio]::SetVolume([int]$cmd.level) }
      "mute" {
        if ($null -ne $cmd.muted) {
          [LocalRemoteAudio]::SetMute([bool]$cmd.muted)
        } else {
          $cur = $false
          try { $cur = [LocalRemoteAudio]::GetMute() } catch {}
          [LocalRemoteAudio]::SetMute(-not $cur)
        }
      }
      "key" { Send-NamedKeys ([string]$cmd.keys) }
      "lock" { Start-Process "rundll32.exe" -ArgumentList "user32.dll,LockWorkStation" | Out-Null }
      "screens-off" { [LocalRemoteKeys]::ScreensOff() }
      "brightness" { Set-BrightnessLevel ([int]$cmd.level) }
    }
    Write-State
  } catch {
    Write-ErrorState $_.Exception.Message
  }
}
