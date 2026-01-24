import { supabase } from "../config/supabase.js";
import { supabaseAdmin } from "./supabase.service.js";
import crypto from "crypto";
import { v5 as uuidv5 } from "uuid";

// ---- GENERADOR DE INVITE CODE ----
export function generateInviteCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

// ---- REGISTRO DE USUARIO ----
export async function registerUser(body) {
  const { userId, email, invite_code } = body ?? {};
  if (!userId) throw new Error("Falta userId");

  const code = String(invite_code ?? "").trim().toUpperCase();

  const normalizedEmail = typeof email === "string" && email.trim() ? email.trim() : null;
  let insertEmail = normalizedEmail;

  const { data: existingById, error: existingByIdErr } = await supabaseAdmin
    .from("usuarios")
    .select("id")
    .eq("id", userId)
    .maybeSingle();

  if (existingByIdErr) throw new Error(existingByIdErr.message);

  if (!existingById?.id && insertEmail) {
    const { data: existingByEmail, error: existingByEmailErr } = await supabaseAdmin
      .from("usuarios")
      .select("id")
      .eq("email", insertEmail)
      .maybeSingle();

    if (existingByEmailErr) throw new Error(existingByEmailErr.message);
    if (existingByEmail?.id && String(existingByEmail.id) !== String(userId)) {
      insertEmail = null;
    }
  }

  if (!existingById?.id) {
    let inserted = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const newInviteCode = generateInviteCode();
      const { error: insertErr } = await supabaseAdmin.from("usuarios").insert({
        id: userId,
        email: insertEmail,
        invite_code: newInviteCode,
      });

      if (!insertErr) {
        inserted = true;
        break;
      }

      const insertCode = String(insertErr.code ?? "");
      const insertMsg = String(insertErr.message ?? "").toLowerCase();
      const isUniqueViolation =
        insertCode === "23505" || insertMsg.includes("duplicate") || insertMsg.includes("unique");
      if (!isUniqueViolation) throw new Error(insertErr.message);
    }

    if (!inserted) {
      throw new Error("No se pudo crear el usuario (colisión de invite_code)");
    }
  }

  const { data: me, error: meErr } = await supabaseAdmin
    .from("usuarios")
    .select("id, invite_code, referred_by")
    .eq("id", userId)
    .maybeSingle();

  if (meErr) throw new Error(meErr.message);
  if (!me?.id) throw new Error("Usuario no encontrado");

  if (!me.invite_code) {
    let updated = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const newInviteCode = generateInviteCode();
      const { error: updateErr } = await supabaseAdmin
        .from("usuarios")
        .update({ invite_code: newInviteCode })
        .eq("id", userId)
        .is("invite_code", null);

      if (!updateErr) {
        updated = true;
        break;
      }

      const updateCode = String(updateErr.code ?? "");
      const updateMsg = String(updateErr.message ?? "").toLowerCase();
      const isUniqueViolation =
        updateCode === "23505" || updateMsg.includes("duplicate") || updateMsg.includes("unique");
      if (!isUniqueViolation) throw new Error(updateErr.message);
    }

    if (!updated) {
      throw new Error("No se pudo asignar un invite_code (colisión)");
    }
  }

  if (normalizedEmail && !insertEmail) {
    const { error: updateEmailErr } = await supabaseAdmin
      .from("usuarios")
      .update({ email: normalizedEmail })
      .eq("id", userId)
      .is("email", null);

    if (updateEmailErr) {
      const code = String(updateEmailErr.code ?? "");
      const msg = String(updateEmailErr.message ?? "").toLowerCase();
      const isUniqueViolation = code === "23505" || msg.includes("duplicate") || msg.includes("unique");
      if (!isUniqueViolation) throw new Error(updateEmailErr.message);
    }
  }

  if (code && !me.referred_by) {
    await linkReferral({ userId, invite_code: code });
  }

  const { data: refreshed, error: refreshedErr } = await supabaseAdmin
    .from("usuarios")
    .select("id, invite_code, referred_by")
    .eq("id", userId)
    .single();

  if (refreshedErr) throw new Error(refreshedErr.message);

  return {
    success: true,
    user_id: refreshed.id,
    invite_code: refreshed.invite_code,
    referred_by: refreshed.referred_by,
  };
}

const COMMISSION_ID_NAMESPACE = "7cf9a4f0-0b3b-4b7b-a6fb-e1b291f254b1";

const getCommissionId = ({ referrerId, buyerId, level, referenciaId, referenciaTipo }) => {
  const key = `commission:${referrerId}:${buyerId}:${level}:${referenciaTipo ?? ''}:${referenciaId ?? ''}`;
  return uuidv5(key, COMMISSION_ID_NAMESPACE);
};

// ---- CREAR NIVELES DE REFERENCIA ----
export async function createReferralLevels(newUserId, directInviterId) {
  const levelsToInsert = [];

  // Nivel 1 directo
  levelsToInsert.push({
    user_id: newUserId,
    ancestor_id: directInviterId,
    level: 1,
  });

  // Buscar si el invitador tiene nivel 1 hacia arriba
  const { data: parentLvl1 } = await supabase
    .from("referral_levels")
    .select("ancestor_id")
    .eq("user_id", directInviterId)
    .eq("level", 1)
    .single();

  if (parentLvl1) {
    // Nivel 2
    levelsToInsert.push({
      user_id: newUserId,
      ancestor_id: parentLvl1.ancestor_id,
      level: 2,
    });

    // Buscar nivel 2 del padre (para nivel 3 del nuevo usuario)
    const { data: parentLvl2 } = await supabase
      .from("referral_levels")
      .select("ancestor_id")
      .eq("user_id", directInviterId)
      .eq("level", 2)
      .single();

    if (parentLvl2) {
      // Nivel 3
      levelsToInsert.push({
        user_id: newUserId,
        ancestor_id: parentLvl2.ancestor_id,
        level: 3,
      });
    }
  }

  if (levelsToInsert.length > 0) {
    await supabaseAdmin.from("referral_levels").insert(levelsToInsert);
  }
}

// ---- GENERAR COMISIONES ----
export async function generateCommissions(fromUserId, amount) {
  const { data: ancestors } = await supabase
    .from("referral_levels")
    .select("*")
    .eq("user_id", fromUserId);

  if (!ancestors || ancestors.length === 0) return;

  for (const a of ancestors) {
    let percentage = 0;

    switch (a.level) {
      case 1:
        percentage = 0.15;
        break;
      case 2:
      case 3:
        percentage = 0.01;
        break;
    }

    const commissionAmount = amount * percentage;

    await supabase.from("commissions").insert({
      user_id: a.ancestor_id,
      from_user_id: fromUserId,
      amount: commissionAmount,
      level: a.level,
    });
  }
}


// Obtener referidos por nivel
export async function getUserReferrals(userId) {
  const result = {
    level1: [],
    level2: [],
    level3: []
  };

  // Nivel 1
  const { data: lvl1 } = await supabase
    .from("usuarios")
    .select("*")
    .eq("referred_by", userId);

  result.level1 = lvl1 || [];

  // Nivel 2
  if (lvl1?.length > 0) {
    const lvl1Ids = lvl1.map(u => u.id);

    const { data: lvl2 } = await supabase
      .from("usuarios")
      .select("*")
      .in("referred_by", lvl1Ids);

    result.level2 = lvl2 || [];
  }

  // Nivel 3
  if (result.level2.length > 0) {
    const lvl2Ids = result.level2.map(u => u.id);

    const { data: lvl3 } = await supabase
      .from("usuarios")
      .select("*")
      .in("referred_by", lvl2Ids);

    result.level3 = lvl3 || [];
  }

  return result;
}

// Obtener comisiones del usuario
export async function getUserCommissions(userId) {
  const { data, error } = await supabase
    .from("commissions")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  let total = 0;
  if (data) {
    total = data.reduce((sum, c) => sum + Number(c.amount), 0);
  }

  return {
    total_earned: total,
    commissions: data || []
  };
}

export async function getMyReferralProfile(userId) {
  if (!userId) throw new Error('Falta userId');

  const { data, error } = await supabaseAdmin
    .from('usuarios')
    .select('id, invite_code, referred_by')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error('Usuario no encontrado');

  return {
    invite_code: data.invite_code ?? null,
    referred_by: data.referred_by ?? null,
  };
}

export async function getMyReferralStats(userId) {
  if (!userId) throw new Error('Falta userId');

  const now = new Date();
  const nowSql = now.toISOString().slice(0, 19).replace('T', ' ');

  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const startOfNextDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)
  );

  const { data: lvl1, error: lvl1Err } = await supabaseAdmin
    .from('usuarios')
    .select('id, email, estado, fecha_registro')
    .eq('referred_by', userId);
  if (lvl1Err) throw new Error(lvl1Err.message);

  const lvl1Ids = (lvl1 || []).map((u) => u.id).filter(Boolean);

  const { data: lvl2, error: lvl2Err } = lvl1Ids.length
    ? await supabaseAdmin
        .from('usuarios')
        .select('id, email, estado, fecha_registro')
        .in('referred_by', lvl1Ids)
    : { data: [], error: null };
  if (lvl2Err) throw new Error(lvl2Err.message);

  const lvl2Ids = (lvl2 || []).map((u) => u.id).filter(Boolean);

  const { data: lvl3, error: lvl3Err } = lvl2Ids.length
    ? await supabaseAdmin
        .from('usuarios')
        .select('id, email, estado, fecha_registro')
        .in('referred_by', lvl2Ids)
    : { data: [], error: null };
  if (lvl3Err) throw new Error(lvl3Err.message);

  const levelUsers = {
    1: lvl1 || [],
    2: lvl2 || [],
    3: lvl3 || [],
  };

  const allTeamIds = [...lvl1Ids, ...lvl2Ids, ...(lvl3 || []).map((u) => u.id).filter(Boolean)];
  const uniqueTeamIds = Array.from(new Set(allTeamIds));

  const { data: activeSubsRaw, error: subsErr } = uniqueTeamIds.length
    ? await supabaseAdmin
        .from('subscriptions')
        .select('user_id, plan_id, created_at, expires_at, is_active, planes(precio)')
        .in('user_id', uniqueTeamIds)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
    : { data: [], error: null };
  if (subsErr) throw new Error(subsErr.message);

  const activeSubsFiltered = (activeSubsRaw || []).filter((r) => {
    const expiresAt = r?.expires_at != null ? String(r.expires_at) : '';
    if (!expiresAt) return true;
    return expiresAt >= nowSql;
  });

  const activeByUser = new Map();
  for (const row of activeSubsFiltered) {
    const uid = row?.user_id;
    if (!uid) continue;
    const arr = activeByUser.get(uid) || [];
    arr.push(row);
    activeByUser.set(uid, arr);
  }

  const { data: commissionsAll, error: commAllErr } = await supabaseAdmin
    .from('commissions')
    .select('amount, level, created_at')
    .eq('user_id', userId);
  if (commAllErr) throw new Error(commAllErr.message);

  const { data: commissionsToday, error: commTodayErr } = await supabaseAdmin
    .from('commissions')
    .select('amount, level, created_at')
    .eq('user_id', userId)
    .gte('created_at', startOfDay.toISOString())
    .lt('created_at', startOfNextDay.toISOString());
  if (commTodayErr) throw new Error(commTodayErr.message);

  const sumAmount = (rows) =>
    (rows || []).reduce((acc, r) => acc + (Number(r?.amount || 0) || 0), 0);

  const totalIngresos = sumAmount(commissionsAll);
  const ingresosHoy = sumAmount(commissionsToday);

  const sumByLevel = (rows, level) =>
    (rows || [])
      .filter((r) => Number(r?.level) === Number(level))
      .reduce((acc, r) => acc + (Number(r?.amount || 0) || 0), 0);

  const recargaFromSubs = (ids) => {
    let total = 0;
    let activos = 0;
    let agregadoHoy = 0;
    for (const id of ids) {
      const subs = activeByUser.get(id);
      if (!subs || !subs.length) continue;
      activos += 1;
      for (const sub of subs) {
        const precio =
          Number(sub?.planes?.precio ?? sub?.planes?.price ?? sub?.planes?.monto ?? 0) || 0;
        total += precio;
        const created = sub?.created_at ? new Date(String(sub.created_at)) : null;
        if (created && created >= startOfDay && created < startOfNextDay) agregadoHoy += precio;
      }
    }
    return { total, activos, agregadoHoy };
  };

  const levelStats = (level) => {
    const users = levelUsers[level] || [];
    const ids = users.map((u) => u.id).filter(Boolean);
    const { total: equipoRecarga, activos: numeroActivos } = recargaFromSubs(ids);
    return {
      nivel: level,
      plantillaTotal: ids.length,
      numeroActivos,
      equipoRecarga,
      regresoTotal: sumByLevel(commissionsAll, level),
      gananciasHoy: sumByLevel(commissionsToday, level),
    };
  };

  const l1 = levelStats(1);
  const l2 = levelStats(2);
  const l3 = levelStats(3);

  const { total: recargaTotal, agregadoHoy } = recargaFromSubs(uniqueTeamIds);

  return {
    totalIngresos,
    ingresosHoy,
    recargaTotal,
    agregadoHoy,
    niveles: [l1, l2, l3],
  };
}

export async function getMyReferralMembers(userId, level) {
  if (!userId) throw new Error('Falta userId');
  const lvl = Number(level);
  if (![1, 2, 3].includes(lvl)) throw new Error('Level inválido');

  const nowSql = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const { data: lvl1, error: lvl1Err } = await supabaseAdmin
    .from('usuarios')
    .select('id, email, estado, fecha_registro')
    .eq('referred_by', userId);
  if (lvl1Err) throw new Error(lvl1Err.message);

  const lvl1Ids = (lvl1 || []).map((u) => u.id).filter(Boolean);

  const { data: lvl2, error: lvl2Err } = lvl1Ids.length
    ? await supabaseAdmin
        .from('usuarios')
        .select('id, email, estado, fecha_registro')
        .in('referred_by', lvl1Ids)
    : { data: [], error: null };
  if (lvl2Err) throw new Error(lvl2Err.message);

  const lvl2Ids = (lvl2 || []).map((u) => u.id).filter(Boolean);

  const { data: lvl3, error: lvl3Err } = lvl2Ids.length
    ? await supabaseAdmin
        .from('usuarios')
        .select('id, email, estado, fecha_registro')
        .in('referred_by', lvl2Ids)
    : { data: [], error: null };
  if (lvl3Err) throw new Error(lvl3Err.message);

  const byLevel = {
    1: lvl1 || [],
    2: lvl2 || [],
    3: lvl3 || [],
  };

  const members = byLevel[lvl] || [];
  const memberIds = members.map((u) => u.id).filter(Boolean);

  const { data: subsRaw, error: subsErr } = memberIds.length
    ? await supabaseAdmin
        .from('subscriptions')
        .select('id, user_id, plan_id, created_at, expires_at, is_active, planes(precio)')
        .in('user_id', memberIds)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
    : { data: [], error: null };
  if (subsErr) throw new Error(subsErr.message);

  const subsFiltered = (subsRaw || []).filter((r) => {
    const expiresAt = r?.expires_at != null ? String(r.expires_at) : '';
    if (!expiresAt) return true;
    return expiresAt >= nowSql;
  });

  const plansByUser = new Map();
  for (const s of subsFiltered) {
    const uid = s?.user_id;
    if (!uid) continue;
    const arr = plansByUser.get(uid) || [];
    arr.push({
      subscription_id: s?.id,
      plan_id: s?.plan_id,
      created_at: s?.created_at,
      expires_at: s?.expires_at,
      precio: Number(s?.planes?.precio ?? 0) || 0,
    });
    plansByUser.set(uid, arr);
  }

  return {
    level: lvl,
    members: (members || []).map((m) => ({
      id: m?.id,
      email: m?.email,
      estado: m?.estado,
      fecha_registro: m?.fecha_registro,
      active_plans: plansByUser.get(m?.id) || [],
    })),
  };
}

export async function linkReferral({ userId, invite_code }) {
  const code = String(invite_code ?? "").trim().toUpperCase();
  if (!code) throw new Error("Falta invite_code");

  const { data: me, error: meErr } = await supabaseAdmin
    .from("usuarios")
    .select("id, referred_by")
    .eq("id", userId)
    .maybeSingle();

  if (meErr) throw new Error(meErr.message);
  if (!me?.id) throw new Error("Usuario no encontrado");
  if (me.referred_by) {
    return {
      ok: true,
      message: "El referido ya está vinculado",
      referred_by: me.referred_by,
    };
  }

  const { data: inviter, error: inviterErr } = await supabaseAdmin
    .from("usuarios")
    .select("id")
    .ilike("invite_code", code)
    .maybeSingle();

  if (inviterErr) throw new Error(inviterErr.message);
  if (!inviter?.id) throw new Error("Código de invitación inválido");
  if (String(inviter.id) === String(userId)) throw new Error("No puedes referirte a ti mismo");

  const { error: updateErr } = await supabaseAdmin
    .from("usuarios")
    .update({ referred_by: inviter.id })
    .eq("id", userId)
    .is("referred_by", null);

  if (updateErr) throw new Error(updateErr.message);

  const { data: existingLevels, error: levelsErr } = await supabaseAdmin
    .from("referral_levels")
    .select("user_id")
    .eq("user_id", userId)
    .limit(1);

  if (levelsErr) throw new Error(levelsErr.message);
  const hasLevels = Array.isArray(existingLevels) && existingLevels.length > 0;
  if (!hasLevels) {
    await createReferralLevels(userId, inviter.id);
  }

  try {
    const nowSql = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('subscriptions')
      .select('id, user_id, plan_id, created_at, expires_at, is_active')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (subErr) throw subErr;
    const expiresAt = sub?.expires_at != null ? String(sub.expires_at) : '';
    const isExpired = Boolean(expiresAt) && expiresAt < nowSql;

    if (sub?.id && sub.is_active === true && !isExpired) {
      const { data: plan, error: planErr } = await supabaseAdmin
        .from('planes')
        .select('*')
        .eq('id', sub.plan_id)
        .maybeSingle();

      if (planErr) throw planErr;
      const precio = Number(plan?.precio ?? plan?.price ?? plan?.monto ?? 0);
      if (Number.isFinite(precio) && precio > 0) {
        await processReferralCommissions(userId, precio, plan, {
          referenciaId: sub.id,
          referenciaTipo: 'vip',
        });
      }
    }
  } catch {
    // ignore
  }

  return {
    ok: true,
    message: "Referido vinculado correctamente",
    referred_by: inviter.id,
  };
}

export const processReferralCommissions = async (
  userId,
  amount,
  plan,
  options = {}
) => {
  try {
    const baseAmount = Number(amount);
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) return;

    const pct1 = Number(plan?.nivel1_pct ?? 15);
    const pct2 = Number(plan?.nivel2_pct ?? 1);
    const pct3 = Number(plan?.nivel3_pct ?? 1);

    const referenciaId = options?.referenciaId ?? null;
    const referenciaTipo = options?.referenciaTipo ?? null;

    const { data: buyer, error: buyerError } = await supabaseAdmin
      .from("usuarios")
      .select("*")
      .eq("id", userId)
      .single();

    if (buyerError || !buyer) return;

    const isUserInactive = (u) => {
      if (!u || typeof u !== "object") return false;
      if (Object.prototype.hasOwnProperty.call(u, "is_active")) return u.is_active === false;
      if (Object.prototype.hasOwnProperty.call(u, "activo")) return u.activo === false;
      if (Object.prototype.hasOwnProperty.call(u, "estado")) {
        const v = u.estado;
        if (typeof v === "string") {
          const s = v.toLowerCase();
          return s === "inactivo" || s === "inactive" || s === "disabled";
        }
        return v === false;
      }
      return false;
    };

    const level1Id = buyer.referred_by ?? null;
    if (!level1Id) return;

    const { data: level1User, error: level1Error } = await supabaseAdmin
      .from("usuarios")
      .select("*")
      .eq("id", level1Id)
      .single();

    if (level1Error || !level1User) return;
    if (!isUserInactive(level1User)) {
      await grantCommission(
        level1Id,
        userId,
        baseAmount,
        pct1,
        1,
        { referenciaId, referenciaTipo }
      );
    }

    const level2Id = level1User.referred_by ?? null;
    if (!level2Id) return;

    const { data: level2User, error: level2Error } = await supabaseAdmin
      .from("usuarios")
      .select("*")
      .eq("id", level2Id)
      .single();

    if (level2Error || !level2User) return;
    if (!isUserInactive(level2User)) {
      await grantCommission(
        level2Id,
        userId,
        baseAmount,
        pct2,
        2,
        { referenciaId, referenciaTipo }
      );
    }

    const level3Id = level2User.referred_by ?? null;
    if (!level3Id) return;

    const { data: level3User, error: level3Error } = await supabaseAdmin
      .from("usuarios")
      .select("*")
      .eq("id", level3Id)
      .single();

    if (level3Error || !level3User) return;
    if (!isUserInactive(level3User)) {
      await grantCommission(
        level3Id,
        userId,
        baseAmount,
        pct3,
        3,
        { referenciaId, referenciaTipo }
      );
    }
  } catch (err) {
    console.error("❌ Error en processReferralCommissions:", err);
  }
};

const grantCommission = async (
  referrerId,
  buyerId,
  baseAmount,
  pct,
  level,
  options = {}
) => {
  const numericPct = Number(pct);
  if (!Number.isFinite(numericPct) || numericPct <= 0) return;

  const commissionAmount = (Number(baseAmount) * numericPct) / 100;
  if (!Number.isFinite(commissionAmount) || commissionAmount <= 0) return;

  const referenciaId = options?.referenciaId ?? buyerId;
  const referenciaTipo = options?.referenciaTipo ?? "referido";

  const { error: insertError } = await supabaseAdmin
    .from("balance_movimientos")
    .insert({
      usuario_id: referrerId,
      tipo: `comision_nivel_${level}`,
      referencia_id: referenciaId,
      referencia_tipo: referenciaTipo,
      monto: commissionAmount,
    });

  if (insertError) {
    const code = String(insertError.code ?? "");
    const msg = String(insertError.message ?? "").toLowerCase();
    if (code === "23505" || msg.includes("duplicate") || msg.includes("unique")) {
      return;
    }
    throw insertError;
  }

  const { error: rpcError } = await supabaseAdmin.rpc("increment_user_balance", {
    userid: referrerId,
    amountdelta: commissionAmount,
  });

  if (rpcError) throw rpcError;

  const commissionId = getCommissionId({
    referrerId,
    buyerId,
    level,
    referenciaId,
    referenciaTipo,
  });

  const { error: insertCommissionErr } = await supabaseAdmin
    .from("commissions")
    .insert({
      id: commissionId,
      user_id: referrerId,
      from_user_id: buyerId,
      amount: commissionAmount,
      level,
    });

  if (insertCommissionErr) {
    const code = String(insertCommissionErr.code ?? "");
    const msg = String(insertCommissionErr.message ?? "").toLowerCase();
    if (code === "23505" || msg.includes("duplicate") || msg.includes("unique")) {
      return;
    }
    throw insertCommissionErr;
  }
};
