/* SlugBase Marketing — Router + root */

function MarketingApp() {
  const [page, setPage] = useState("home");

  // Scroll to top on navigation
  useEffect(() => { window.scrollTo({ top: 0, behavior: "instant" }); }, [page]);

  const legalTab = page.startsWith("legal-") ? page.replace("legal-", "") : null;

  return (
    <div>
      <MkNav page={page} setPage={setPage} />
      {page === "home"                 && <LandingPage setPage={setPage} />}
      {page === "pricing"              && <PricingPage setPage={setPage} />}
      {page === "contact"              && <ContactPage />}
      {page.startsWith("legal")        && <LegalPage tab={legalTab || "impressum"} />}
      <MkFooter setPage={setPage} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<MarketingApp />);
