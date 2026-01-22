import express from "express";
import { authMiddleware } from "../middlewares/auth.js";
import {
  registerUserController,
  getReferralsController,
  getCommissionsController,
  getMyReferralsController,
  getMyCommissionsController,
  linkReferralController,
  getMyReferralProfileController,
  getMyReferralStatsController
} from "../controllers/referral.controller.js";

const router = express.Router();

// Registrar usuario con o sin código
router.post("/register", authMiddleware, registerUserController);

// Mis referidos (niveles 1-3)
router.get("/me/referrals", authMiddleware, getMyReferralsController);

// Mis comisiones
router.get("/me/commissions", authMiddleware, getMyCommissionsController);

// Mi perfil referral (invite_code, referred_by)
router.get("/me/profile", authMiddleware, getMyReferralProfileController);

// Mis métricas de promoción (niveles 1-3)
router.get("/me/stats", authMiddleware, getMyReferralStatsController);

// Asociar un invite_code al usuario autenticado (1 vez)
router.post("/link", authMiddleware, linkReferralController);

// Obtiene referidos por niveles 1-3 (legacy: restringido al usuario autenticado)
router.get("/referrals/:userId", authMiddleware, getReferralsController);

// Obtiene todas las comisiones del usuario (legacy: restringido al usuario autenticado)
router.get("/commissions/:userId", authMiddleware, getCommissionsController);

export default router;
