import miraImg from "../assets/coach_mira.png";
import kaiImg from "../assets/coach_kai.png";

import userFem from "../assets/avatars/user_fem.png";
import userMasc from "../assets/avatars/user_masc.png";
import userNeutral from "../assets/avatars/user_neutral.png";

export const avatarMap = {
  fem: { label: "Feminine", img: userFem },
  masc: { label: "Masculine", img: userMasc },
  neutral: { label: "Neutral", img: userNeutral },
};

export const COACHES = {
  mira: { id: "mira", name: "Mira", avatar: miraImg },
  kai: { id: "kai", name: "Kai", avatar: kaiImg },
};

