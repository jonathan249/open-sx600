"use client";

import { FlaskConical, History, House, Moon, PanelLeft, PanelRight, Settings, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, type CSSProperties, type ReactNode, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { BikeStatusDot, useBluetoothSupported } from "@/components/connectivity";
import { Btn, Label } from "@/components/kit";
import { RightPanel } from "@/components/right-panel";
import { useBikeState, useEngine } from "@/components/bike-provider";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getTheme, setTheme, subscribeTheme } from "@/lib/theme";

const NAV = [
  { href: "/", label: "Home", icon: House },
  { href: "/history", label: "History", icon: History },
  { href: "/workouts", label: "Playground", icon: FlaskConical },
];

const TITLES: Record<string, string> = {
  "/": "Home",
  "/history": "History",
  "/workouts": "Playground",
  "/debug": "Debug log",
  "/settings": "Settings",
};

/**
 * Two shadcn sidebars on a grey canvas, with the page in a white inset panel. On desktop both
 * are fixed: navigation on the left is always the icon strip, the panel on the right is always
 * open. On phones they become drawers, opened from the top bar.
 * The left provider is nested inside the right one, so the right sidebar's controls are
 * handed down through RightSidebarContext for the top bar.
 */
const keep = () => {};
const RightSidebarContext = createContext<ReturnType<typeof useSidebar> | null>(null);

function RightBridge({ children }: { children: ReactNode }) {
  const right = useSidebar();
  return <RightSidebarContext.Provider value={right}>{children}</RightSidebarContext.Provider>;
}

function NavSidebar() {
  const pathname = usePathname();
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader className="h-12 justify-center px-2">
        <Link href="/" className="flex items-center gap-2.5 px-1 text-[15px] font-medium tracking-wordmark">
          <span className="size-5 shrink-0 rounded-md bg-gradient-to-br from-spot-soft via-spot to-[#3b5bdb]" aria-hidden />
          <span className="group-data-[collapsible=icon]:hidden">SX600</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Ride</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map(({ href, label, icon: Icon }) => (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton isActive={pathname === href} tooltip={label} render={<Link href={href} />}>
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={pathname === "/settings"} tooltip="Settings" render={<Link href="/settings" />}>
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <ThemeToggle />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

const STATUS_TEXT = {
  idle: "Not connected",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  error: "Connection failed",
} as const;

function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => "light" as const);
  const dark = theme === "dark";
  const label = dark ? "Light mode" : "Dark mode";
  return (
    <SidebarMenuButton tooltip={label} aria-label={label} onClick={() => setTheme(dark ? "light" : "dark")}>
      {dark ? <Sun /> : <Moon />}
      <span>{label}</span>
    </SidebarMenuButton>
  );
}

function TopBar() {
  const left = useSidebar();
  const right = useContext(RightSidebarContext);
  const engine = useEngine();
  const { status, name } = useBikeState();
  const pathname = usePathname();
  const supported = useBluetoothSupported();
  const linked = status === "connected" || status === "reconnecting";

  // On phones both sidebars are drawers: close them once a link has taken the user elsewhere.
  const closeLeft = left.setOpenMobile;
  const closeRight = right?.setOpenMobile;
  useEffect(() => {
    closeLeft(false);
    closeRight?.(false);
  }, [pathname, closeLeft, closeRight]);

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 bg-background px-4">
      <button
        type="button"
        onClick={left.toggleSidebar}
        className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
        aria-label="Open navigation"
      >
        <PanelLeft className="size-4" />
      </button>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">SX600</span>
        <span className="text-input">/</span>
        <span className="font-medium">{TITLES[pathname] ?? ""}</span>
      </div>
      <div className="ml-auto flex items-center gap-4">
        <Label className="hidden items-center gap-2 sm:flex" aria-live="polite">
          <BikeStatusDot status={status} />
          {status === "connected" ? `Live · ${name}` : STATUS_TEXT[status]}
        </Label>
        <Btn
          variant={linked ? "outline" : "solid"}
          onClick={() => (linked ? engine.disconnect() : engine.connect())}
          disabled={(!supported && !linked) || status === "connecting"}
        >
          {linked ? "Disconnect" : "Connect"}
        </Btn>
        <button
          type="button"
          onClick={right?.toggleSidebar}
          className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
          aria-label="Open panel"
        >
          <PanelRight className="size-4" />
        </button>
      </div>
    </header>
  );
}

/**
 * The page scrolls inside the white panel, not the window, so the panel keeps its margin and
 * rounded frame on the grey canvas, and the top bar stays in place.
 */
function ScrollArea({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  // A new page starts at the top (the browser only does this for window scrolling).
  useEffect(() => {
    ref.current?.scrollTo({ top: 0 });
  }, [pathname]);
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="px-4 pb-4">{children}</div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <SidebarProvider open onOpenChange={keep} shortcut="" className="h-svh min-h-0 overflow-hidden" style={{ "--sidebar-width": "24rem" } as CSSProperties}>
        <RightBridge>
          <SidebarProvider
            open={false}
            onOpenChange={keep}
            shortcut=""
            className="h-svh min-h-0 min-w-0 flex-1"
            style={{ "--sidebar-width-icon": "3rem" } as CSSProperties}
          >
            <NavSidebar />
            <SidebarInset className="h-svh min-h-0 min-w-0 overflow-hidden md:peer-data-[variant=inset]:h-[calc(100svh-1rem)] md:peer-data-[variant=inset]:rounded-2xl md:peer-data-[variant=inset]:shadow-none">
              <TopBar />
              <ScrollArea>{children}</ScrollArea>
            </SidebarInset>
          </SidebarProvider>
        </RightBridge>
        <RightPanel />
      </SidebarProvider>
    </TooltipProvider>
  );
}
