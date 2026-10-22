import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import DispatchPage from "@/pages/dispatch";
import { lazy, Suspense } from "react";

// Lazy so the capture page never pulls in leaflet (PR #62 regression: Vite
// optimized leaflet on first load and reloaded the page mid Web Lock acquire).
const DriversPage = lazy(() => import("@/pages/drivers"));

function DriversRoute() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading drivers…</div>}>
      <DriversPage />
    </Suspense>
  );
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={DispatchPage} />
      <Route path="/drivers" component={DriversRoute} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router hook={useHashLocation}>
          <AppRouter />
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
