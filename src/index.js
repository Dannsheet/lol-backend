import 'dotenv/config'
import app from './app.js'
import { supabase } from './config/supabase.js'
import './workers/withdrawal.worker.js';

const PORT = process.env.PORT || 3000

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
