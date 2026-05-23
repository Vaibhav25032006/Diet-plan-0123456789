export enum PlanType {
  HEALTHY_FITNESS = "Healthy Fitness",
  MUSCLE_BUILDING = "Muscle Building",
  WEIGHT_LOSS = "Weight Loss",
  WEIGHT_GAIN = "Weight Gain",
  KIDS_PROGRESS = "Kids Progress"
}

export interface Task {
  id: string; // e.g. "6:30-hydration"
  time: string; // e.g. "06:30 AM" or "6:30 AM"
  hour: number; // 24-hour hour integer (e.g. 6)
  minute: number; // minute integer (e.g. 30)
  titleEn: string;
  titleHi: string;
  descriptionEn: string;
  descriptionHi: string;
  isHerbalifeProduct: boolean;
  requiredProduct?: string; // e.g. "Afresh", "DinoShake", "Formula-1"
  noCameraNeeded: boolean; // true for sleep tasks
  healthyAlternatives?: string[]; // fallback items
}

export interface Member {
  memberId: string;
  name: string;
  goal: PlanType | string;
}

export interface DailyProgress {
  [dateKey: string]: {
    [taskId: string]: {
      completed: boolean;
      timestamp: string;
      imageVerified?: boolean;
    };
  };
}
