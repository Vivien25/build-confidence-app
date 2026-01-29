import { useNavigate } from "react-router-dom";
import { getProfile, saveProfile } from "../utils/profile";
import {
  Briefcase,
  Heart,
  Sparkles,
  Users,
  MoreHorizontal
} from "lucide-react";

const FOCUS_CONFIG = {
  work: {
    label: "Career & Work",
    icon: Briefcase,
    color: "#818cf8",
    bg: "#1e1b4b",
    border: "#312e81"
  },
  relationship: {
    label: "Relationships",
    icon: Heart,
    color: "#34d399",
    bg: "#064e3b",
    border: "#065f46"
  },
  appearance: {
    label: "Appearance",
    icon: Sparkles,
    color: "#fbbf24",
    bg: "#422006",
    border: "#713f12"
  },
  social: {
    label: "Social Confidence",
    icon: Users,
    color: "#ec4899",
    bg: "#500724",
    border: "#831843"
  },
  others: {
    label: "Everything Else",
    icon: MoreHorizontal,
    color: "#cbd5e1",
    bg: "#334155",
    border: "#475569"
  }
};

export default function Focus() {
  const navigate = useNavigate();
  const profile = getProfile();

  const onSelect = (focus) => {
    saveProfile({
      ...profile,
      focus,
      updatedAt: new Date().toISOString(),
    });
    navigate("/chat");
  };

  return (
    <div style={{ maxWidth: 520, margin: "20px auto", padding: "60px 24px", minHeight: "90vh" }}>
      <h2 style={{ fontSize: 36, fontWeight: 900, textAlign: "center", marginBottom: 12, color: "#ffffff", letterSpacing: "-0.025em" }}>
        What's your priority?
      </h2>
      <p style={{ textAlign: "center", color: "#9ca3af", marginBottom: 48, fontSize: 18, fontWeight: 500 }}>
        Select a focus area to tailor your growth journey.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {Object.entries(FOCUS_CONFIG).map(([key, config]) => {
          const Icon = config.icon;
          return (
            <button
              key={key}
              onClick={() => onSelect(key)}
              style={{
                display: "flex",
                alignItems: "center",
                width: "100%",
                padding: "24px",
                borderRadius: 20,
                border: `1px solid ${config.border}`,
                backgroundColor: config.bg,
                cursor: "pointer",
                transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                textAlign: "left",
                boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)"
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = "translateX(8px)";
                e.currentTarget.style.borderColor = config.color;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = "translateX(0)";
                e.currentTarget.style.borderColor = config.border;
              }}
            >
              <div style={{
                width: 52,
                height: 52,
                borderRadius: 14,
                backgroundColor: "rgba(255, 255, 255, 0.05)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginRight: 20,
                border: "1px solid rgba(255, 255, 255, 0.1)",
                color: config.color
              }}>
                <Icon size={26} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 800, fontSize: 20, color: "#ffffff" }}>
                  {config.label}
                </div>
                <div style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, fontWeight: 500 }}>
                  Build confidence in your {key} life.
                </div>
              </div>
              <div style={{ color: config.color, fontSize: 20, fontWeight: 700 }}>→</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
