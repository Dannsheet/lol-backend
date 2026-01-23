import {
  registerUser,
  getUserReferrals,
  getUserCommissions,
  linkReferral,
  getMyReferralProfile,
  getMyReferralStats,
  getMyReferralMembers
} from "../services/referrals.service.js";

// Controlador para registrar usuario
export async function registerUserController(req, res) {
  try {
    const authedId = req.user?.id;
    const authedEmail = req.user?.email;
    if (!authedId) return res.status(401).json({ error: 'No autenticado' });

    const { invite_code } = req.body ?? {};
    const result = await registerUser({ userId: authedId, email: authedEmail, invite_code });
    return res.status(201).json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

// Listar referidos de un usuario (niveles 1-3)
export async function getReferralsController(req, res) {
  try {
    const userId = req.params.userId;
    const authedId = req.user?.id;
    if (!authedId) return res.status(401).json({ error: 'No autenticado' });
    if (String(userId) !== String(authedId)) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    const result = await getUserReferrals(userId);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

// Listar comisiones de un usuario
export async function getCommissionsController(req, res) {
  try {
    const userId = req.params.userId;
    const authedId = req.user?.id;
    if (!authedId) return res.status(401).json({ error: 'No autenticado' });
    if (String(userId) !== String(authedId)) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    const result = await getUserCommissions(userId);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

export async function getMyReferralsController(req, res) {
  try {
    const authedId = req.user?.id;
    if (!authedId) return res.status(401).json({ error: 'No autenticado' });
    const result = await getUserReferrals(authedId);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

export async function getMyCommissionsController(req, res) {
  try {
    const authedId = req.user?.id;
    if (!authedId) return res.status(401).json({ error: 'No autenticado' });
    const result = await getUserCommissions(authedId);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

export async function linkReferralController(req, res) {
  try {
    const authedId = req.user?.id;
    if (!authedId) return res.status(401).json({ error: 'No autenticado' });

    const { invite_code } = req.body ?? {};
    const result = await linkReferral({ userId: authedId, invite_code });
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

export async function getMyReferralProfileController(req, res) {
  try {
    const authedId = req.user?.id;
    if (!authedId) return res.status(401).json({ error: 'No autenticado' });
    const result = await getMyReferralProfile(authedId);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

export async function getMyReferralStatsController(req, res) {
  try {
    const authedId = req.user?.id;
    if (!authedId) return res.status(401).json({ error: 'No autenticado' });
    const result = await getMyReferralStats(authedId);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

export async function getMyReferralMembersController(req, res) {
  try {
    const authedId = req.user?.id;
    if (!authedId) return res.status(401).json({ error: 'No autenticado' });
    const level = req.query?.level;
    const result = await getMyReferralMembers(authedId, level);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}
