import { useNavigate } from "react-router-dom";
import { getProfile, saveProfile } from "../utils/profile";

const FOCUSES = ["work", "relationship", "appearance", "social"];

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
    <div style={{ maxWidth: 640, margin: "0 auto", padding: 16 }}>
      <h2>What do you want to work on now?</h2>
      <p>You can switch focus anytime.</p>

      {FOCUSES.map((f) => (
        <button
          key={f}
          onClick={() => onSelect(f)}
          style={{
            display: "block",
            width: "100%",
            padding: 14,
            marginBottom: 12,
            borderRadius: 10,
            border: "1px solid #e5e7eb",
            fontSize: 16,
            cursor: "pointer",
          }}
        >
          {f.charAt(0).toUpperCase() + f.slice(1)}
        </button>
      ))}
    </div>
  );
}
