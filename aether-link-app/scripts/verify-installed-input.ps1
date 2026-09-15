param([string]$ReportPath)
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSEdition -eq 'Core') {
  $windowsPowerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  if ($ReportPath) { $arguments += @('-ReportPath', $ReportPath) }
  & $windowsPowerShell @arguments
  exit $LASTEXITCODE
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
public class InputProbeForm : Form {
 public readonly List<string> Messages=new List<string>();
 protected override void WndProc(ref Message m) {
  if(m.Msg==0x21||m.Msg==0x201||m.Msg==0x202||m.Msg==0x204||m.Msg==0x205||m.Msg==0x100||m.Msg==0x101||m.Msg==0x6)
   Messages.Add(m.Msg.ToString("X")+":"+m.WParam+":"+m.LParam);
  base.WndProc(ref m);
 }
}
public static class InstalledInputVerification {
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
 public static string Run() {
  SetProcessDPIAware();
  var start = new ProcessStartInfo(@"C:\Program Files (x86)\WonRemote Agent\bin\wonremote-poc.exe", "--mode input-server");
  start.UseShellExecute=false; start.CreateNoWindow=true;
  start.RedirectStandardInput=true; start.RedirectStandardOutput=true; start.RedirectStandardError=true;
  using(var process=Process.Start(start)) using(var form=new InputProbeForm()) {
   var events=new HashSet<string>();
   var messages=new List<string>();
   var completed=new TaskCompletionSource<string>();
   form.Text="WonRemote input verification"; form.Size=new Size(500,300);
   form.StartPosition=FormStartPosition.Manual; form.Location=new Point(30,30); form.TopMost=true; form.KeyPreview=true;
   form.MouseDown+=(s,e)=>{lock(events)events.Add(e.Button==MouseButtons.Left?"left":e.Button==MouseButtons.Right?"right":"other");};
   form.MouseWheel+=(s,e)=>{if(e.Delta!=0)lock(events)events.Add("wheel");};
   form.KeyDown+=(s,e)=>{if(e.KeyCode==Keys.F12){lock(events)events.Add("keyboard");e.Handled=true;}};
   var oldCursor=Cursor.Position;
   form.Shown+=(s,e)=>{
    ShowWindow(form.Handle,5); form.Activate();
    var point=form.PointToScreen(new Point(220,140)); var screen=SystemInformation.VirtualScreen;
    var handle=form.Handle; var bounds=form.Bounds; var hit=WindowFromPoint(point);
    int x=(int)Math.Round((point.X-screen.Left)*65535.0/Math.Max(1,screen.Width-1));
    int y=(int)Math.Round((point.Y-screen.Top)*65535.0/Math.Max(1,screen.Height-1));
    string xy=x+" "+y;
    Task.Run(()=>{
     string failure=null;
     try {
      if(hit!=handle)throw new InvalidOperationException("Test form is covered");
      string[] commands={"move "+xy,"mouse-down "+xy+" left","mouse-up "+xy+" left","mouse-down "+xy+" right","mouse-up "+xy+" right","mouse-wheel "+xy+" 120","key-down F12","key-up F12"};
      for(int index=0;index<commands.Length;index++){
       process.StandardInput.WriteLine("{\"id\":\"probe-"+index+"\",\"action\":\""+commands[index]+"\"}");
       process.StandardInput.Flush();
       var response=process.StandardOutput.ReadLineAsync();
       if(!response.Wait(3000))throw new TimeoutException("Input response timed out at "+commands[index]);
       var line=response.Result??"EOF"; messages.Add(line);
       if(!line.Contains("\"ok\":true"))throw new InvalidOperationException(line);
       Thread.Sleep(40);
      }
      Thread.Sleep(250);
     } catch(Exception error) { failure=error.Message; }
     bool passed;
     lock(events)passed=failure==null&&events.Contains("left")&&events.Contains("right")&&events.Contains("wheel")&&events.Contains("keyboard")&&messages.Count==8;
     var geometry="target="+point+" screen="+screen+" absolute="+xy+" bounds="+bounds+" hit="+hit+" form="+handle+" cursor="+Cursor.Position+" foreground="+GetForegroundWindow();
     string eventText; lock(events)eventText=String.Join(",",events);
     completed.SetResult("passed="+passed+"; events="+eventText+"; replies="+messages.Count+"; failure="+failure+"; geometry="+geometry+"; messages="+String.Join(",",form.Messages));
     try { form.BeginInvoke((Action)(()=>form.Close())); } catch(InvalidOperationException) {}
    });
   };
   try {
    Application.Run(form);
    if(!completed.Task.Wait(15000))return "passed=False; failure=Input test timed out";
    return completed.Task.Result;
   } finally {
    if(!process.HasExited)process.Kill(); process.WaitForExit(); Cursor.Position=oldCursor;
   }
  }
 }
}
'@
$result = [InstalledInputVerification]::Run()
if ($ReportPath) { $result | Set-Content -Encoding UTF8 -LiteralPath $ReportPath }
Write-Output $result
if (-not $result.StartsWith('passed=True;')) { exit 1 }
