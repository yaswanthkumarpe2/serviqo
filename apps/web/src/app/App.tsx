import { BrowserRouter, useLocation } from "react-router-dom";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { CookieConsent } from "@/features/consent/CookieConsent";
import { AppRoutes } from "@/routes/AppRoutes";

/**
 * The cookie notice, everywhere except an organisation's customer chat page.
 *
 * The notice exists to say that Serviqo's one cookie keeps STAFF signed in
 * (ADR-035 §6). A customer on `/widget/<slug>` never signs in and is sent no
 * cookie (ADR-037), so the notice would be untrue for them — and on a phone it
 * sits over the message box they came to type in.
 */
function CookieConsentOutsideCustomerChat() {
  const { pathname } = useLocation();
  if (pathname.startsWith("/widget/")) return null;
  return <CookieConsent />;
}

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
        <CookieConsentOutsideCustomerChat />
      </AuthProvider>
    </BrowserRouter>
  );
}
