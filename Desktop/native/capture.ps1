param([switch]$ValidateOnly,[switch]$TestPolicy)
$ErrorActionPreference='Stop'
try {
 Add-Type -AssemblyName System.Drawing
 Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
public static class PublicCapture {
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect rect);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
 public static string Capture(long handle,long panelWindow,int owner,int[] expected,int[] crop,int[][] masks){
  if(SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero)throw new Exception("capture_dpi_unverified");
  var h=new IntPtr(handle);uint pid;GetWindowThreadProcessId(h,out pid);
  if(!IsWindowVisible(h)||IsIconic(h)||Process.GetProcessById((int)pid).ProcessName!="chrome")throw new Exception("capture_window_changed");
  var foreground=GetForegroundWindow();uint foregroundPid;GetWindowThreadProcessId(foreground,out foregroundPid);
  if(foreground!=h && !(foreground.ToInt64()==panelWindow && foregroundPid==owner))throw new Exception("capture_inactive");
  Rect rect;if(!GetWindowRect(h,out rect))throw new Exception("capture_window_changed");
  if(Math.Abs(rect.Left-expected[0])>2||Math.Abs(rect.Top-expected[1])>2||Math.Abs(rect.Right-rect.Left-expected[2])>2||Math.Abs(rect.Bottom-rect.Top-expected[3])>2)throw new Exception("capture_geometry_changed");
  var clip=new Rectangle(crop[0]-rect.Left,crop[1]-rect.Top,crop[2],crop[3]);
  int width=rect.Right-rect.Left,height=rect.Bottom-rect.Top;
  if(width<=0||height<=0||width>4096||height>4096||!new Rectangle(0,0,width,height).Contains(clip))throw new Exception("capture_bounds_invalid");
  using(var bitmap=new Bitmap(width,height,PixelFormat.Format32bppArgb)){
   using(var g=Graphics.FromImage(bitmap)){
    var dc=g.GetHdc();try{if(!PrintWindow(h,dc,2))throw new Exception("capture_unavailable");}finally{g.ReleaseHdc(dc);}
   }
   Rect after;if(!GetWindowRect(h,out after)||after.Left!=rect.Left||after.Top!=rect.Top||after.Right!=rect.Right||after.Bottom!=rect.Bottom||GetForegroundWindow()!=foreground)throw new Exception("capture_window_changed");
   return CropAndEncode(bitmap,clip,crop,masks);
  }
 }
 static string CropAndEncode(Bitmap bitmap,Rectangle clip,int[] crop,int[][] masks){
   using(var content=bitmap.Clone(clip,PixelFormat.Format24bppRgb)){
    using(var g=Graphics.FromImage(content))foreach(var mask in masks)g.FillRectangle(Brushes.Black,mask[0]-crop[0]-4,mask[1]-crop[1]-4,mask[2]+8,mask[3]+8);
    bool different=false;var first=content.GetPixel(0,0).ToArgb();
    for(int y=0;y<content.Height&&!different;y+=Math.Max(1,content.Height/12))for(int x=0;x<content.Width;x+=Math.Max(1,content.Width/12))if(content.GetPixel(x,y).ToArgb()!=first){different=true;break;}
    if(!different)throw new Exception("capture_blank");
    double scale=Math.Min(1,Math.Min(1280.0/content.Width,800.0/content.Height));
    using(var resized=new Bitmap(Math.Max(1,(int)(content.Width*scale)),Math.Max(1,(int)(content.Height*scale)),PixelFormat.Format24bppRgb)){
     using(var g=Graphics.FromImage(resized))g.DrawImage(content,0,0,resized.Width,resized.Height);
     using(var stream=new MemoryStream()){resized.Save(stream,ImageFormat.Png);if(stream.Length>1572864)throw new Exception("capture_size_limit");return Convert.ToBase64String(stream.ToArray());}
    }
   }
 }
 public static void CheckPolicy(){
  using(var sample=new Bitmap(200,180)){
   using(var g=Graphics.FromImage(sample)){g.Clear(Color.Blue);g.FillRectangle(Brushes.White,10,40,180,120);g.FillRectangle(Brushes.Red,40,60,30,30);}
   string encoded=CropAndEncode(sample,new Rectangle(10,40,180,120),new[]{10,40,180,120},new[]{new[]{40,60,30,30}});
   using(var stream=new MemoryStream(Convert.FromBase64String(encoded)))using(var image=new Bitmap(stream)){
    if(image.Width!=180||image.Height!=120||image.GetPixel(35,25).ToArgb()!=Color.Black.ToArgb()||image.GetPixel(0,0).ToArgb()!=Color.White.ToArgb())throw new Exception("capture_policy_failed");
   }
  }
 }
}
'@ -ReferencedAssemblies System.Drawing
 if($ValidateOnly){'CAPTURE_COMPILE_PASS';return}
 if($TestPolicy){[PublicCapture]::CheckPolicy();'CAPTURE_POLICY_PASS';return}
 $packet=[Console]::In.ReadToEnd() | ConvertFrom-Json
 $encoded=[PublicCapture]::Capture([long]$packet.window,[long]$packet.panel,[int]$packet.owner,[int[]]$packet.bounds,[int[]]$packet.crop,[int[][]]$packet.masks)
 [Console]::WriteLine($encoded)
}catch{[Console]::Error.WriteLine('capture_unavailable');exit 1}
