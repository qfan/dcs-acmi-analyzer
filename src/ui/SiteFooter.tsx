import { Trans, useTranslation } from "react-i18next";

const REPO_URL = "https://github.com/qfan/dcs-acmi-analyzer";

/** About / disclaimer footer shown on the viewer, the analytics page and the BVR Trainer game. */
export function SiteFooter({
  product = "viewer",
  className,
}: {
  product?: "viewer" | "game";
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <footer className={className ? `site-footer ${className}` : "site-footer"}>
      {product === "game" ? (
        <p>
          <Trans i18nKey="footer.gameIntro" components={[<strong key="0" />]} />
        </p>
      ) : (
        <p>
          <Trans i18nKey="footer.viewerIntro" components={[<strong key="0" />, <code key="1" />]} />
        </p>
      )}
      <p>
        <Trans i18nKey="footer.disclaimer" components={[<strong key="0" />]} />
      </p>
      <p>{t("footer.aiNotice")}</p>
      <p className="site-footer-links">
        <a href={`${REPO_URL}/blob/master/LICENSE`}>{t("footer.license")}</a>
        <span aria-hidden="true">·</span>
        <a href={REPO_URL}>{t("footer.sourceOnGithub")}</a>
        <span aria-hidden="true">·</span>
        <a href="./third-party-licenses.txt">{t("footer.thirdPartyLicenses")}</a>
      </p>
    </footer>
  );
}
