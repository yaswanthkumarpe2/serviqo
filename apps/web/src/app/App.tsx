import { BrowserRouter } from "react-router-dom";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { CookieConsent } from "@/features/consent/CookieConsent";
import { AppRoutes } from "@/routes/AppRoutes";

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
        {/*
          Outside the routes, so one notice serves every page rather than each
          surface mounting its own — and so answering it on the landing page
          does not bring it back on the next navigation (ADR-035 §6).
        */}
        <CookieConsent />
      </AuthProvider>
    </BrowserRouter>
  );
}
