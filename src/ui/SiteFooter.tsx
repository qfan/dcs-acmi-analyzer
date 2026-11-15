const REPO_URL = "https://github.com/qfan/dcs-acmi-analyzer";

/** About / disclaimer footer shown on the viewer, the analytics page and the BVR Trainer game. */
export function SiteFooter({
  product = "viewer",
  className,
}: {
  product?: "viewer" | "game";
  className?: string;
}) {
  return (
    <footer className={className ? `site-footer ${className}` : "site-footer"}>
      {product === "game" ? (
        <p>
          <strong>BVR Trainer</strong> is a free, unofficial, open-source browser game for practising
          beyond-visual-range air combat decisions. It runs entirely in your browser. Aircraft, missile, radar
          and AI behaviour are simplified game estimates: they are not real-world or DCS World data, and the
          game is not a simulation of real systems.
        </p>
      ) : (
        <p>
          <strong>ACMI Viewer</strong> is a free, unofficial, open-source tool for viewing and analysing
          Tacview flight recordings (<code>.acmi</code>) from DCS World. Recordings are processed entirely in
          your browser and are never uploaded.
        </p>
      )}
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
