import { Navbar } from "@/features/marketing/Navbar/Navbar";
import { Hero } from "@/features/marketing/Hero/Hero";
import { FeatureOverview } from "@/features/marketing/FeatureOverview/FeatureOverview";
import { UnifiedInbox } from "@/features/marketing/UnifiedInbox/UnifiedInbox";
import { AiHuman } from "@/features/marketing/AiHuman/AiHuman";
import { Ticketing } from "@/features/marketing/Ticketing/Ticketing";
import { Automation } from "@/features/marketing/Automation/Automation";
import { KnowledgeBase } from "@/features/marketing/KnowledgeBase/KnowledgeBase";
import { Analytics } from "@/features/marketing/Analytics/Analytics";
import { WebsiteWidget } from "@/features/marketing/WebsiteWidget/WebsiteWidget";
import { Security } from "@/features/marketing/Security/Security";
import { Integrations } from "@/features/marketing/Integrations/Integrations";
import { FinalCta } from "@/features/marketing/FinalCta/FinalCta";
import { Footer } from "@/features/marketing/Footer/Footer";

export function LandingPage() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <FeatureOverview />
        <UnifiedInbox />
        <AiHuman />
        <Ticketing />
        <Automation />
        <KnowledgeBase />
        <Analytics />
        <WebsiteWidget />
        <Security />
        <Integrations />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
