const REPO_URL = "https://github.com/qfan/dcs-acmi-analyzer";

/** About / disclaimer footer shown on both the viewer and the analytics page. */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p>
        <strong>ACMI Viewer</strong> is a free, unofficial, open-source tool for viewing and analysing Tacview
        flight recordings (<code>.acmi</code>) from DCS World. Recordings are processed entirely in your
        browser and are never uploaded.
      </p>
      <p>
        This project is <strong>not affiliated with, endorsed by, or sponsored by</strong> Eagle Dynamics (DCS
        World) or Raia Software (Tacview). DCS World and Tacview are trademarks of their respective owners.
      </p>
      <p>
        The code was written largely by AI coding assistants (Claude Code and Google Antigravity) and is
        provided as-is, without warranty. Results may be inaccurate.
      </p>
      <p className="site-footer-links">
        <a href={`${REPO_URL}/blob/master/LICENSE`}>0BSD License</a>
        <span aria-hidden="true">·</span>
        <a href={REPO_URL}>Source on GitHub</a>
        <span aria-hidden="true">·</span>
        <a href="./third-party-licenses.txt">Third-party licenses</a>
      </p>
    </footer>
  );
}
