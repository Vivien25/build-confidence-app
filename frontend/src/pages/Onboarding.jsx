import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getProfile, saveProfile } from "../utils/profile";

const AVATARS = [
  { id: "fem", label: "Feminine avatar" },
  { id: "masc", label: "Masculine avatar" },
  { id: "neutral", label: "Neutral avatar" },
  { id: "custom", label: "Let me choose later" },
];

export default function Onboarding() {
  const navigate = useNavigate();
  const existing = useMemo(() => getProfile(), []);

  const [name, setName] = useState(existing?.name ?? "");
  const [avatar, setAvatar] = useState(existing?.avatar ?? "neutral");
  const [focus, setFocus] = useState(existing?.focus ?? "work");

  const onContinue = () => {
    saveProfile({
      name: name.trim(),
      avatar,
      focus,
      coachAvatar: "coach_mira",
      createdAt: new Date().toISOString(),
    });
    navigate("/work");
  };

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: 16 }}>
      <h2>Quick setup</h2>
      <p>We’ll personalize your experience. You can change this later.</p>

      {/* Name */}
      <div style={{ marginTop: 16 }}>
        <label>
          Name (optional)
          <input
            style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Vivien"
          />
        </label>
      </div>

      {/* Avatar */}
      <div style={{ marginTop: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          Choose an avatar style
        </div>

        {AVATARS.map((a) => (
          <label key={a.id} style={{ display: "block", marginBottom: 8 }}>
            <input
              type="radio"
              name="avatar"
              value={a.id}
              checked={avatar === a.id}
              onChange={() => setAvatar(a.id)}
              style={{ marginRight: 8 }}
            />
            {a.label}
          </label>
        ))}
      </div>

      {/* Focus area */}
      <div style={{ marginTop: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          What do you want to work on right now?
        </div>

        {["family", "appearance", "relationship", "work"].map((item) => (
          <label key={item} style={{ display: "block", marginBottom: 8 }}>
            <input
              type="radio"
              name="focus"
              value={item}
              checked={focus === item}
              onChange={() => setFocus(item)}
              style={{ marginRight: 8 }}
            />
            {item.charAt(0).toUpperCase() + item.slice(1)}
          </label>
        ))}
      </div>

      <button
        onClick={onContinue}
        style={{ marginTop: 20, padding: "10px 14px" }}
      >
        Continue
      </button>
    </div>
  );
}
