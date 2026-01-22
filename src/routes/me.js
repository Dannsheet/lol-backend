import express from 'express'
import { authMiddleware } from '../middlewares/auth.js'

const router = express.Router()

router.get('/me', authMiddleware, (req, res) => {
  res.json({
    message: 'Usuario autenticado correctamente',
    user: req.user
  })
})

export default router
