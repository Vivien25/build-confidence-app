import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { saveProfile } from "../utils/profile";

import coachMira from "../assets/avatars/coach_mira.png";
import coachKai from "../assets/avatars/coach_kai.png";

export default function Welcome() {
  const navigate = useNavigate();

  // ✅ responsive breakpoint
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 900);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const pickCoach = (coachId) => {
    saveProfile({ coachId });
    navigate("/intro");
  };

  return (
    <div style={styles.page}>
      <div style={isMobile ? styles.layoutMobile : styles.layout}>
        {/* LEFT */}
        <div style={styles.left}>
          <h1 style={isMobile ? styles.titleMobile : styles.title}>Better Me</h1>
          <p style={styles.subtitle}>
             Confidence isn&apos;t found;
              <span style={styles.subtitleEmphasis}>
             {" "}it’s built, step by step,
            </span>
           <span style={styles.subtitleSoft}> right in your pocket.</span>
          </p>
        </div>

        {/* RIGHT */}
        <div style={styles.right}>
          {isMobile ? (
            // ✅ Mobile: simple stacked cards (no diagonal clipping)
            <div style={styles.rightMobile}>
              <div
                style={styles.coachCard}
                onClick={() => pickCoach("mira")}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") pickCoach("mira");
                }}
              >
                <img src={coachMira} alt="Mira" style={styles.coachImg} />
                <div>
                  <div style={styles.coachName}>Mira</div>
                  <div style={styles.coachVibe}>Compassionate</div>
                </div>
              </div>

              <div
                style={styles.coachCard}
                onClick={() => pickCoach("kai")}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") pickCoach("kai");
                }}
              >
                <img src={coachKai} alt="Kai" style={styles.coachImg} />
                <div>
                  <div style={styles.coachName}>Kai</div>
                  <div style={styles.coachVibe}>Empowering</div>
                </div>
              </div>

              <div style={{ ...styles.hint, textAlign: "left" }}>
                Tap to choose your coach.
              </div>
            </div>
          ) : (
            // ✅ Desktop: diagonal split hero
            <>
              <div style={styles.splitPanel}>
                {/* LEFT SIDE (Mira) */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => pickCoach("mira")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") pickCoach("mira");
                  }}
                  style={styles.leftWrap}
                  aria-label="Choose Mira"
                  title="Mira"
                >
                  <div style={styles.backdropLeft} />
                  <img src={coachMira} alt="Mira" style={styles.faceSafeLeft} />

                  <div style={styles.labelLeft}>
                    <div style={styles.coachName}>Mira</div>
                    <div style={styles.coachVibe}>Compassionate</div>
                  </div>
                </div>

                {/* RIGHT SIDE (Kai) */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => pickCoach("kai")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") pickCoach("kai");
                  }}
                  style={styles.rightWrap}
                  aria-label="Choose Kai"
                  title="Kai"
                >
                  <div style={styles.backdropRight} />
                  <img src={coachKai} alt="Kai" style={styles.faceSafeRight} />

                  <div style={styles.labelRight}>
                    <div style={styles.coachName}>Kai</div>
                    <div style={styles.coachVibe}>Empowering</div>
                  </div>
                </div>

                {/* subtle unify overlay */}
                <div style={styles.overlay} />
              </div>

              <div style={styles.hint}>Click a side to choose your coach.</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ✅ You can tune these numbers to shift the diagonal left/right
const LEFT_POLY = "polygon(0 0, 56% 0, 38% 100%, 0 100%)";
const RIGHT_POLY = "polygon(56% 0, 100% 0, 100% 100%, 38% 100%)";

const styles = {
  page: {
    minHeight: "100vh",
    padding: "48px 24px",
    display: "flex",
    alignItems: "center",
  },

  layout: {
    width: "min(1200px, 96vw)",
    margin: "0 auto",
    display: "grid",
    gridTemplateColumns: "520px 1fr",
    gap: 36,
    alignItems: "center",
  },

  layoutMobile: {
    width: "min(720px, 96vw)",
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: 22,
    alignItems: "stretch",
  },

  left: { textAlign: "left" },

  // Desktop title
  title: {
    margin: 0,
    fontSize: 100,
    fontWeight: 900,
    letterSpacing: "-2px",
    color: "#3a2f2a",
    lineHeight: 0.98,
  },

  // Mobile title
  titleMobile: {
    margin: 0,
    fontSize: 56,
    fontWeight: 900,
    letterSpacing: "-1.4px",
    color: "#3a2f2a",
    lineHeight: 1.0,
  },

  subtitle: {
    margin: "16px 0 0 0",
    fontSize: 18,
    lineHeight: 1.7,
    color: "rgba(58,47,42,0.72)",
    maxWidth: 520,
  },

  right: { width: "100%" },

  // ---------- Desktop split hero ----------
  splitPanel: {
    position: "relative",
    width: "100%",
    height: "min(640px, 78vh)",
    borderRadius: 26,
    overflow: "hidden",
    border: "1px solid rgba(58,47,42,0.18)",
    boxShadow: "0 26px 80px rgba(0,0,0,0.14)",
    background: "rgba(255,255,255,0.45)",
  },

  leftWrap: {
    position: "absolute",
    inset: 0,
    clipPath: LEFT_POLY,
    WebkitClipPath: LEFT_POLY,
    cursor: "pointer",
    outline: "none",
    zIndex: 1,
  },

  rightWrap: {
    position: "absolute",
    inset: 0,
    clipPath: RIGHT_POLY,
    WebkitClipPath: RIGHT_POLY,
    cursor: "pointer",
    outline: "none",
    zIndex: 2,
  },

  backdropLeft: {
    position: "absolute",
    inset: 0,
    background:
      "radial-gradient(900px 600px at 30% 30%, rgba(255,233,215,0.95), rgba(255,255,255,0.55) 55%, rgba(127,191,163,0.20))",
  },

  backdropRight: {
    position: "absolute",
    inset: 0,
    background:
      "radial-gradient(900px 600px at 70% 30%, rgba(255,233,215,0.80), rgba(255,255,255,0.50) 55%, rgba(227,139,109,0.18))",
  },

  faceSafeLeft: {
    position: "absolute",
    inset: "-6% -8%",
    width: "116%",
    height: "112%",
    objectFit: "contain",
    objectPosition: "10% center",
    filter: "drop-shadow(0 18px 30px rgba(0,0,0,0.15))",
    pointerEvents: "none",
  },

  // ✅ Kai: crop to left 2/3 + shift content right
  faceSafeRight: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",

    // crop to left ~66%
    //clipPath: "inset(0 34% 0 0)",
    //WebkitClipPath: "inset(0 34% 0 0)",

    // zoom + move right (tune these)
    transform: "scale(1.08) translateX(20%)",
    transformOrigin: "center",

    filter: "drop-shadow(0 18px 30px rgba(0,0,0,0.15))",
    pointerEvents: "none",
  },

  overlay: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    background:
      "linear-gradient(90deg, rgba(255,255,255,0.10), rgba(255,255,255,0.04) 40%, rgba(255,255,255,0.10))",
    zIndex: 3,
  },

  labelLeft: {
    position: "absolute",
    left: 18,
    bottom: 18,
    padding: "10px 12px",
    borderRadius: 14,
    background: "rgba(255,255,255,0.78)",
    border: "1px solid rgba(58,47,42,0.18)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    textAlign: "left",
    pointerEvents: "none",
  },

  labelRight: {
    position: "absolute",
    right: 18,
    bottom: 18,
    padding: "10px 12px",
    borderRadius: 14,
    background: "rgba(255,255,255,0.78)",
    border: "1px solid rgba(58,47,42,0.18)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    textAlign: "left",
    pointerEvents: "none",
  },

  // ---------- Mobile cards ----------
  rightMobile: {
    width: "100%",
    display: "grid",
    gap: 14,
  },

  coachCard: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: 16,
    borderRadius: 18,
    background: "rgba(255,255,255,0.88)",
    border: "1px solid rgba(58,47,42,0.14)",
    boxShadow: "0 14px 40px rgba(0,0,0,0.08)",
    cursor: "pointer",
    userSelect: "none",
  },

  coachImg: {
    width: 72,
    height: 72,
    borderRadius: "50%",
    objectFit: "cover",
    flex: "0 0 auto",
  },

  coachName: {
    fontWeight: 900,
    color: "#3a2f2a",
    fontSize: 16,
    lineHeight: 1.1,
  },

  coachVibe: {
    marginTop: 2,
    fontSize: 13,
    color: "rgba(58,47,42,0.68)",
  },

  hint: {
    marginTop: 10,
    fontSize: 13,
    color: "rgba(58,47,42,0.60)",
    textAlign: "right",
  },
};
