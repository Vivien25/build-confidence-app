import { useNavigate } from "react-router-dom";
import { saveProfile } from "../utils/profile";

export default function Welcome() {
  const navigate = useNavigate();

  const pickCoach = (coachId) => {
    saveProfile({ coachId });
    navigate("/intro"); // keep your existing flow
  };

  return (
    <div style={{ padding: 24, maxWidth: 520, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 8 }}>Better Me</h1>
      <p style={{ marginTop: 0, lineHeight: 1.5 }}>
        Your friendly coach to grow confidence step by step.
      </p>

      <div style={{ marginTop: 20, display: "grid", gap: 12 }}>
        <button
          onClick={() => pickCoach("mira")}
          style={{ padding: "10px 14px", cursor: "pointer" }}
        >
          Meet Mira →
        </button>

        <button
          onClick={() => pickCoach("kai")}
          style={{ padding: "10px 14px", cursor: "pointer" }}
        >
          Meet Kai →
        </button>
      </div>
    </div>
  );
}
