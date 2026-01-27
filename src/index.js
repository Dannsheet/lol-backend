import 'dotenv/config'
import app from './app.js'
import { supabase } from './config/supabase.js'
import './workers/withdrawal.worker.js';
import './workers/deposit.worker.js';

const PORT = Number.parseInt(process.env.PORT, 10) || 8080

try {
  const raw = String(process.env.SUPABASE_URL || '')
  const host = raw ? new URL(raw).host : ''
  console.log('🔧 SUPABASE_URL host:', host || '(missing)')
} catch {
  console.log('🔧 SUPABASE_URL host: (invalid)')
}

const testSupabase = async () => {
  const { data, error } = await supabase
    .from('usuarios')
    .select('id')
    .limit(1)

  if (error) {
    console.error('❌ Error Supabase:', error.message)
  } else {
    console.log('✅ Supabase conectado correctamente')
  }
}

testSupabase()

app.listen(PORT, () => {
  console.log(`🚀 API corriendo en puerto ${PORT}`)
})
