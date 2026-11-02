param([int]$OwnerPid=0,[long]$PanelWindow=0,[long]$OverlayWindow=0,[switch]$Once,[switch]$ValidateOnly,[switch]$Diagnose,[switch]$TestTracking)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
 Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
 $source=@'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Automation;
public static class Reader {
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc,IntPtr arg);
 delegate bool EnumProc(IntPtr h,IntPtr arg);
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] static extern IntPtr GetTopWindow(IntPtr parent);
 [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window,uint command);
 [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window,int index);
 [StructLayout(LayoutKind.Sequential)] struct Bounds {public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out Bounds bounds);
 static bool OverlayOverChrome(IntPtr chrome,long overlay,double x,double y) {
   if(overlay==0)return false;
   int style=GetWindowLong(new IntPtr(overlay),-20);
   if((style&0x20)==0 || (style&0x08000000)==0)return false;
   var h=GetTopWindow(IntPtr.Zero);
   for(int i=0;h!=IntPtr.Zero&&i<200;i++,h=GetWindow(h,2)) {
     if(h.ToInt64()==overlay || !IsWindowVisible(h) || IsIconic(h))continue;
     Bounds b;
     if(GetWindowRect(h,out b)&&x>=b.Left&&x<b.Right&&y>=b.Top&&y<b.Bottom)return h==chrome;
   }
   return false;
 }
 static IntPtr tracked=IntPtr.Zero;
 static string salt=Guid.NewGuid().ToString();
 static string Hash(string raw) {using(var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(salt+raw))).Replace("-","").Substring(0,20);}
 static string Key(AutomationElement e) { return Hash(string.Join("-",e.GetRuntimeId())); }
 static object Box(System.Windows.Rect r) { return new {x=r.X,y=r.Y,width=r.Width,height=r.Height}; }
 static bool Chrome(IntPtr h) {
   if(h==IntPtr.Zero || !IsWindow(h) || !IsWindowVisible(h) || IsIconic(h)) return false;
   uint pid;GetWindowThreadProcessId(h,out pid);
   try {return Process.GetProcessById((int)pid).ProcessName=="chrome";}catch{return false;}
 }
 static int requested=0;
 public static void StartInput() {
   var reader=new Thread(delegate(){string line;while((line=Console.ReadLine())!=null){if(line=="discover")Interlocked.Exchange(ref requested,1);}});
   reader.IsBackground=true;reader.Start();
 }
 public static bool TakeDiscover(){return Interlocked.Exchange(ref requested,0)==1;}
 public static void StartFocusWatch(int owner,long panelWindow) {
   var thread=new Thread(delegate(){
     IntPtr previous=GetForegroundWindow();
     while(true) {
       Thread.Sleep(100);var current=GetForegroundWindow();if(current==previous)continue;previous=current;
       uint pid;GetWindowThreadProcessId(current,out pid);
       string kind=owner!=0&&(int)pid==owner&&current.ToInt64()==panelWindow?"panel":Chrome(current)?"chrome":"other";
       Console.WriteLine("{\"event\":\"foreground\",\"focus\":\""+kind+"\",\"window\":\""+current.ToInt64()+"\"}");
     }
   });thread.IsBackground=true;thread.Start();
 }
 public static string Route(bool chrome,bool panel,bool discover,bool retained) {
   if(chrome)return "foreground";
   if(panel||discover)return retained?"retained":discover?"discover":"unselected";
   return "inactive";
 }
 public static void CheckTracking() {
   if(Route(true,false,false,false)!="foreground" || Route(false,false,false,true)!="inactive"
      || Route(false,true,false,true)!="retained" || Route(false,true,true,false)!="discover"
      || Route(false,true,false,false)!="unselected")throw new Exception("tracking_regression");
   const string url="https://www.bokjiro.go.kr/ssis-tbu/index.do";
   foreach(var display in new[]{url,"www.bokjiro.go.kr/ssis-tbu/index.do","bokjiro.go.kr/ssis-tbu/index.do"})
     if(VerifiedAddress(display,url)!=url)throw new Exception("official_document_url_rejected");
   foreach(var display in new[]{"http://www.bokjiro.go.kr/ssis-tbu/index.do","www.bokjiro.go.kr.evil.test/ssis-tbu/index.do","bokjiro.go.kr/other"})
     if(VerifiedAddress(display,url)!=null)throw new Exception("unmatched_address_accepted");
   if(VerifiedAddress("www.bokjiro.go.kr/ssis-tbu/index.do",null)!=null
      || VerifiedAddress(url,"https://example.com/")!=null)throw new Exception("unverified_document_accepted");
 }
 class Nav {
   public AutomationElement root,document;
   public string raw,tab="",reason="addressbar_missing";
   public bool verified=false,omittedScheme=false;
   public bool documentUrlUsed=false;
   public int nodes,edits,documents,selected;
 }
 class Node {
   public AutomationElement element;public bool web,toolbar;public int depth;
   public Node(AutomationElement e,bool w,bool t,int d){element=e;web=w;toolbar=t;depth=d;}
 }
 static bool Official(string raw) {
   Uri u;return Uri.TryCreate(raw,UriKind.Absolute,out u)&&u.Scheme=="https"&&u.Host=="www.bokjiro.go.kr"&&u.IsDefaultPort&&u.UserInfo=="";
 }
 static string VerifiedAddress(string address,string documentUrl) {
   if(Official(address))return string.IsNullOrEmpty(documentUrl)||address==documentUrl?address:null;
   if(string.IsNullOrEmpty(address)||address.Contains("://")||!Official(documentUrl))return null;
   // scheme은 추측하지 않고 같은 탭의 문서 URL로 확인한다.
   string display=documentUrl.Substring("https://".Length);
   return address==display||(display.StartsWith("www.")&&address==display.Substring(4))?documentUrl:null;
 }
 static Nav Inspect(IntPtr handle) {
   var nav=new Nav(); nav.root=AutomationElement.FromHandle(handle);
   uint rootPid;GetWindowThreadProcessId(handle,out rootPid);
   var todo=new Queue<Node>();todo.Enqueue(new Node(nav.root,false,false,0));
   var timer=Stopwatch.StartNew();var walk=TreeWalker.ControlViewWalker;
   while(todo.Count>0 && nav.nodes++<450 && timer.ElapsedMilliseconds<500) {
     var node=todo.Dequeue();var e=node.element;
     try {
       var c=e.Current;bool document=c.ControlType==ControlType.Document;
       if(document) {nav.documents++;if(!c.IsOffscreen && nav.document==null)nav.document=e;continue;}
       bool web=node.web || (c.ClassName??"").StartsWith("Chrome_RenderWidgetHost") || c.ProcessId!=(int)rootPid;
       bool bar=node.toolbar || c.ControlType==ControlType.ToolBar;
       if(!web && !c.IsOffscreen && c.ControlType==ControlType.TabItem) {
         object pattern;if(e.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern)&&((SelectionItemPattern)pattern).Current.IsSelected){nav.selected++;nav.tab=Key(e);}
       }
       // 웹 Document 내부로 내려가지 않고 브라우저 chrome의 주소창만 읽는다.
       if(!web && bar && !c.IsOffscreen && c.ControlType==ControlType.Edit && !c.IsPassword) {
         nav.edits++;
         bool named=c.Name=="Address and search bar"||c.Name=="주소창 및 검색창"||c.Name=="주소 및 검색창";
         bool identified=c.AutomationId=="omnibox"||c.AutomationId=="address and search bar";
         if(named||identified) {object value;if(e.TryGetCurrentPattern(ValuePattern.Pattern,out value))nav.raw=((ValuePattern)value).Current.Value;}
       }
       if(node.depth>=10)continue;
       var child=walk.GetFirstChild(e);
       for(int siblings=0;child!=null&&siblings<100;siblings++) {todo.Enqueue(new Node(child,web,bar,node.depth+1));child=walk.GetNextSibling(child);}
     }catch(ElementNotAvailableException){}
   }
   if(nav.raw!=null) {
     string documentUrl=null;object value;
     if(nav.document!=null && nav.document.TryGetCurrentPattern(ValuePattern.Pattern,out value))documentUrl=((ValuePattern)value).Current.Value;
     string verified=VerifiedAddress(nav.raw,documentUrl);
     nav.documentUrlUsed=verified!=null&&!Official(nav.raw);
     nav.omittedScheme=!nav.raw.Contains("://") && (nav.raw.StartsWith("www.bokjiro.go.kr/")||nav.raw=="www.bokjiro.go.kr"||nav.raw.StartsWith("bokjiro.go.kr/")||nav.raw=="bokjiro.go.kr");
     nav.verified=verified!=null;
     if(nav.verified)nav.raw=verified;
     nav.reason=nav.verified?"verified":nav.omittedScheme?"url_scheme_missing":"url_not_target";
   }
   if(nav.verified && nav.selected!=1) {nav.reason="selected_tab_unverified";nav.verified=false;}
   return nav;
 }
 static List<IntPtr> Windows() {
   var result=new List<IntPtr>();EnumWindows(delegate(IntPtr h,IntPtr arg){if(Chrome(h)&&result.Count<6)result.Add(h);return true;},IntPtr.Zero);return result;
 }
 public static object Diagnose() {
   SetThreadDpiAwarenessContext(new IntPtr(-4));
   var results=new List<object>();
   foreach(var handle in Windows()) {
     var time=Stopwatch.StartNew();
     try {var n=Inspect(handle);results.Add(new {reason=n.reason,verified=n.verified,schemeOmitted=n.omittedScheme,documentUrlUsed=n.documentUrlUsed,browserEditCount=n.edits,documentCount=n.documents,selectedTabCount=n.selected,navigationNodes=n.nodes,elapsedMs=time.ElapsedMilliseconds});}
     catch(Exception e){results.Add(new {reason="uia_read_failed",errorType=e.GetType().Name,elapsedMs=time.ElapsedMilliseconds});}
   }
   return new {chromeWindowCount=results.Count,windows=results};
 }
 public static object Read(int owner,long panelWindow,long overlayWindow,string[] publicLabels,bool discover) {
   if(SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero)return new {available=false,reason="dpi_unverified"};
   var foreground=GetForegroundWindow();uint pid;GetWindowThreadProcessId(foreground,out pid);
   bool panel=owner!=0&&(int)pid==owner&&foreground.ToInt64()==panelWindow;
   IntPtr candidate=IntPtr.Zero;Nav nav=null;
   string route=Route(Chrome(foreground),panel,discover,Chrome(tracked));
   if(route=="foreground") {candidate=foreground;nav=Inspect(candidate);}
   else if(route=="retained" || route=="discover" || route=="unselected") {
     if(Chrome(tracked)){candidate=tracked;nav=Inspect(candidate);}
     if((nav==null||!nav.verified)&&discover) {
       var matches=new List<IntPtr>();var navigation=new List<Nav>();
       foreach(var handle in Windows()) {
         try {var found=Inspect(handle);if(found.verified){matches.Add(handle);navigation.Add(found);}}catch{}
       }
       if(matches.Count>1)return new {available=false,reason="ambiguous_target"};
       if(matches.Count==1){candidate=matches[0];nav=navigation[0];}
       else return new {available=false,reason=Windows().Count==0?"chrome_not_found":"target_not_found"};
     }
   } else return new {available=false,reason=foreground==IntPtr.Zero?"foreground_unavailable":"other_app"};
   if(nav==null)return new {available=false,reason="target_not_selected"};
   if(!Chrome(candidate))return new {available=false,reason="chrome_closed"};
   if(!nav.verified)return new {available=false,reason=nav.reason};
   tracked=candidate;
   bool active=foreground==candidate;
   if(nav.document==null)return new {available=false,verified=true,active=active,window=candidate.ToInt64().ToString(),tab=nav.tab,reason="no_accessibility_document"};
   var root=nav.root;var document=nav.document;
   var allowed=new HashSet<string>(publicLabels);
   var pageLabels=new HashSet<string>();var context=new List<object>();var masks=new List<object>();bool captureSafe=true;double? scrollPercent=null;object scrolling;bool formOpen=false;
   var modalRoots=new List<AutomationElement>();
   if(document.TryGetCurrentPattern(ScrollPattern.Pattern,out scrolling)) {
     var state=((ScrollPattern)scrolling).Current;
     if(state.VerticallyScrollable && state.VerticalScrollPercent>=0 && state.VerticalScrollPercent<=100)scrollPercent=state.VerticalScrollPercent;
   }
   // 모달 안에 입력 항목이 있는지만 확인하고 이름·값·선택 내용은 읽지 않는다.
   var dialogs=document.FindAll(TreeScope.Descendants,new AndCondition(
     new PropertyCondition(AutomationElement.IsWindowPatternAvailableProperty,true),new PropertyCondition(AutomationElement.IsOffscreenProperty,false)));
   for(int i=0;i<dialogs.Count && i<4;i++) {
     object windowPattern;
     if(dialogs[i].TryGetCurrentPattern(WindowPattern.Pattern,out windowPattern) && ((WindowPattern)windowPattern).Current.IsModal) {
       modalRoots.Add(dialogs[i]);
       var input=dialogs[i].FindFirst(TreeScope.Descendants,new AndCondition(
         new OrCondition(new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Edit),new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.ComboBox)),
         new PropertyCondition(AutomationElement.IsPasswordProperty,false),new PropertyCondition(AutomationElement.IsOffscreenProperty,false),new PropertyCondition(AutomationElement.IsEnabledProperty,true)));
       if(input!=null)formOpen=true;
     }
   }
   bool scopedToModal=modalRoots.Count==1;
   var items=new List<object>();var pending=new Queue<AutomationElement>();pending.Enqueue(scopedToModal?modalRoots[0]:document);
   var timer=Stopwatch.StartNew();int count=0;
   var walker=TreeWalker.ControlViewWalker;
   while(pending.Count>0 && items.Count<60 && count++<2500 && timer.ElapsedMilliseconds<900) {
     var element=pending.Dequeue();
     try {
       var c=element.Current;
       if(!c.IsOffscreen && (c.IsPassword||c.ControlType==ControlType.Edit||c.ControlType==ControlType.ComboBox||c.ControlType==ControlType.CheckBox||c.ControlType==ControlType.RadioButton||c.ControlType==ControlType.Slider||c.ControlType==ControlType.Spinner||c.ControlType==ControlType.List||c.ControlType==ControlType.DataGrid)) {
         var inputRect=c.BoundingRectangle;
         if(inputRect.IsEmpty || inputRect.Width<=0 || inputRect.Height<=0 || masks.Count>=40)captureSafe=false;
         else masks.Add(Box(inputRect));
       }
       bool actionable=c.ControlType==ControlType.Button || c.ControlType==ControlType.Hyperlink || c.ControlType==ControlType.MenuItem;
       if(actionable && !c.IsPassword) {
         string name=(c.Name??"").Trim();
         if(allowed.Contains(name)) {
           var r=c.BoundingRectangle;bool hit=false;
           if(!r.IsEmpty && r.Width>0 && r.Height>0 && !c.IsOffscreen && (active||panel)) {
             // 링크 외곽의 패딩은 다른 그룹으로 노출될 수 있어 실제 선택할 중앙을 검증한다.
             var at=AutomationElement.FromPoint(new System.Windows.Point(r.X+r.Width*.5,r.Y+r.Height*.5));
             bool ownOverlay=false;
             for(int ancestor=0;!hit && at!=null && ancestor<6;ancestor++,at=TreeWalker.ControlViewWalker.GetParent(at)) {
               hit=Automation.Compare(element,at);
               if(at.Current.ProcessId==owner && at.Current.NativeWindowHandle==overlayWindow)ownOverlay=true;
             }
             if(!hit&&ownOverlay)hit=OverlayOverChrome(candidate,overlayWindow,r.X+r.Width*.5,r.Y+r.Height*.5);
           }
           if(!r.IsEmpty && !Double.IsInfinity(r.X) && !Double.IsInfinity(r.Y)) {
             var id=Key(element);
             items.Add(new {id=id,name=name,role=c.ControlType.ProgrammaticName.Replace("ControlType.",""),rect=Box(r),offscreen=c.IsOffscreen,enabled=c.IsEnabled,hit=hit,in_modal=scopedToModal});
           }
         }
       }
       // 메뉴 안의 텍스트와 구분해 허용된 본문 라벨만 전달한다. 입력값은 읽지 않는다.
       if(c.ControlType==ControlType.Text && !c.IsPassword && !c.IsOffscreen && pageLabels.Count<8) {
         var name=(c.Name??"").Trim();
         if(allowed.Contains(name)) {
           bool inControl=false;var parent=walker.GetParent(element);
           for(int depth=0;parent!=null && depth<4;depth++,parent=walker.GetParent(parent)) {
             var type=parent.Current.ControlType;
             if(type==ControlType.Button || type==ControlType.Hyperlink || type==ControlType.MenuItem){inControl=true;break;}
           }
           if(!inControl){pageLabels.Add(name);if(context.Count<12)context.Add(new {kind="text",text=name});}
         }
       }
       // 입력값·선택값·임의 도움말은 읽지 않고 검토된 라벨만 포함한다.
       if(!c.IsPassword && !c.IsOffscreen && context.Count<12 && (c.ControlType==ControlType.Edit || c.ControlType==ControlType.ComboBox)) {
         var name=(c.Name??"").Trim();
         if(allowed.Contains(name))context.Add(new {kind="label",text=name});
       }
       var child=walker.GetFirstChild(element);while(child!=null) {pending.Enqueue(child);child=walker.GetNextSibling(child);if(pending.Count>3000)break;}
     }catch(ElementNotAvailableException){}
   }

   var after=Inspect(candidate);
   if(!after.verified || after.raw!=nav.raw || after.tab!=nav.tab || GetForegroundWindow()!=foreground)return new {available=false,reason="target_changed_during_read"};
   // 첫 비교는 로그인 정보가 없는 공식 공개 홈으로 한정한다. 임의 경로로 넓히지 않는다.
   var uri=new Uri(nav.raw);bool publicHome=uri.AbsolutePath=="/ssis-tbu/index.do" && uri.Query=="" && uri.Fragment=="";
   if(document.FindFirst(TreeScope.Descendants,new AndCondition(new PropertyCondition(AutomationElement.NameProperty,"로그아웃"),new PropertyCondition(AutomationElement.IsOffscreenProperty,false)))!=null)captureSafe=false;
   return new {available=true,verified=true,active=active,panel_focused=panel,window=candidate.ToInt64().ToString(),tab=nav.tab,navigation=Hash(nav.raw),document=Key(document),viewport=Box(document.Current.BoundingRectangle),window_rect=Box(root.Current.BoundingRectangle),capture_eligible=publicHome&&captureSafe&&pending.Count==0&&!scopedToModal,mask_rects=masks,elements=items,screen_context=context,page_labels=pageLabels,scroll_percent=scrollPercent,form_open=formOpen,modal_open=modalRoots.Count>0,partial=pending.Count>0};
 }
}
'@
 Add-Type -TypeDefinition $source -ReferencedAssemblies @('UIAutomationClient','UIAutomationTypes','WindowsBase','System.Core')
 if($ValidateOnly){'UIA_COMPILE_PASS'|Write-Output;return}
 if($TestTracking){[Reader]::CheckTracking();'UIA_TRACKING_POLICY_PASS'|Write-Output;return}
 if($Diagnose){[Reader]::Diagnose() | ConvertTo-Json -Compress -Depth 5 | Write-Output;return}
 $labels=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../shared/public-labels.json') -Encoding UTF8 -Raw | ConvertFrom-Json
 if(-not $Once){[Reader]::StartInput();[Reader]::StartFocusWatch($OwnerPid,$PanelWindow)}
 $discover=$true
 do {
   if([Reader]::TakeDiscover()){$discover=$true}
   try {$json=[Reader]::Read($OwnerPid,$PanelWindow,$OverlayWindow,[string[]]$labels,$discover)|ConvertTo-Json -Compress -Depth 6;[Console]::WriteLine($json)}
   catch {$type=$_.Exception.GetBaseException().GetType().Name;$json=@{available=$false;reason='uia_read_failed';errorType=$type}|ConvertTo-Json -Compress;[Console]::WriteLine($json)}
   $discover=$false
   if(-not $Once){Start-Sleep -Milliseconds 400}
 }while(-not $Once)
}catch {'{"available":false,"reason":"uia_unavailable"}'|Write-Output}
