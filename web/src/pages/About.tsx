import { useI18n } from "../i18n";
import { linkProps } from "../router";

export function AboutPage() {
  const { t } = useI18n();
  return (
    <div className="prose">
      <h1>{t("about.title")}</h1>
      <p>{t("about.p1")}</p>

      <h2>{t("about.h1")}</h2>
      <ul>
        <li>{t("about.l1")}</li>
        <li>{t("about.l2")}</li>
        <li>{t("about.l3")}</li>
      </ul>

      <h2>{t("about.h2")}</h2>
      <p>{t("about.p2")}</p>
      <ul>
        {(["ACTIONABLE", "LIMITED", "INFORMATIONAL", "HIDDEN_BY_DEFAULT", "UNAVAILABLE"] as const).map((s, i) => (
          <li key={s}>
            <strong>{t(`use.${s}`)}</strong>: {t(`about.s${i + 1}` as "about.s1")}
          </li>
        ))}
      </ul>
      <p>{t("about.p3")}</p>

      <h2>{t("about.h3")}</h2>
      <p>{t("about.p4")}</p>

      <h2>{t("about.h4")}</h2>
      <p>{t("about.p5")}</p>

      <h2>{t("about.h5")}</h2>
      <p>
        {t("about.p6")} <a {...linkProps("/coverage")}>{t("about.seeCoverage")}</a>
      </p>
      <p className="faint small">{t("about.p7")}</p>
    </div>
  );
}
