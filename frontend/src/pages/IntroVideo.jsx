import { useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";

// ✅ Use a PUBLIC, DIRECT .mp4 URL (Cloudinary / S3 / GCS / etc.)
const VIDEO_URL = "https://YOUR_PUBLIC_VIDEO_URL_HERE.mp4";

export default function IntroVideo() {
  const navigate = useNavigate();
  const videoRef = useRef(null);
  const [isMuted, setIsMuted] = useState(true);

  const goNext = () => {
    navigate("/onboarding");
  };

  // Go to onboarding when video ends
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleEnded = () => goNext();
    video.addEventListener("ended", handleEnded);

    return () => video.removeEventListener("ended", handleEnded);
  }, []);

  // Enable sound after user interaction (required by browsers)
  const enableSound = async () => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = false;
    setIsMuted(false);

    try {
      await video.play(); // required for iOS / Safari
    } catch (err) {
      console.log("Play blocked:", err);
    }
  };

  return (
    <div style={styles.container}>
      <video
        ref={videoRef}
        src={VIDEO_URL}
        autoPlay
        muted={isMuted}
        playsInline
        preload="auto"
        controls={false}
        style={styles.video}
      />

      {/* Tap to enable sound */}
      {isMuted && (
        <button style={styles.soundBtn} onClick={enableSound}>
          🔊 Tap for sound
        </button>
      )}

      {/* Skip button */}
      <button style={styles.skipBtn} onClick={goNext}>
        Skip
      </button>
    </div>
  );
}

const styles = {
  container: {
    position: "fixed",
    inset: 0,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  video: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "contain", // change to "cover" if you want full bleed
    objectPosition: "center",
  },
  soundBtn: {
    position: "absolute",
    left: 20,
    bottom: 20,
    padding: "10px 14px",
    borderRadius: 10,
    border: "none",
    background: "rgba(0,0,0,0.6)",
    color: "#fff",
    fontSize: 14,
    cursor: "pointer",
    zIndex: 2,
  },
  skipBtn: {
    position: "absolute",
    right: 20,
    top: 20,
    padding: "10px 14px",
    borderRadius: 10,
    border: "none",
    background: "rgba(0,0,0,0.6)",
    color: "#fff",
    fontSize: 14,
    cursor: "pointer",
    zIndex: 2,
  },
};
