import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

const CART_KEY = 'm-hustle-cart-v1'
const CartContext = createContext(null)

function readCart() {
  try {
    const raw = localStorage.getItem(CART_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        typeof item.seller_id === 'string' &&
        Number.isFinite(Number(item.price)) &&
        Number.isFinite(Number(item.quantity)),
    )
  } catch {
    return []
  }
}

export function CartProvider({ children }) {
  const [items, setItems] = useState(readCart)

  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(items))
    } catch {
      // Storage can be unavailable in private mode; the in-memory cart still works.
    }
  }, [items])

  const addItem = useCallback((listing, quantity = 1, sellerName = '') => {
    const stock = Math.max(0, Number(listing.quantity ?? 1))
    if (stock <= 0) return false

    const amount = Math.min(Math.max(Number(quantity) || 1, 1), 99, stock)

    setItems((current) => {
      const existing = current.find((item) => item.id === listing.id)

      if (existing) {
        return current.map((item) =>
          item.id === listing.id
            ? {
                ...item,
                stock,
                quantity: Math.min(item.quantity + amount, 99, stock),
              }
            : item,
        )
      }

      return [
        ...current,
        {
          id: listing.id,
          title: listing.title,
          price: Number(listing.price),
          image_url: listing.image_url ?? null,
          category: listing.category ?? 'Other',
          seller_id: listing.seller_id,
          seller_name: sellerName || listing.seller?.full_name || listing.seller?.username || 'Seller',
          stock,
          quantity: amount,
        },
      ]
    })

    return true
  }, [])

  const removeItem = useCallback((listingId) => {
    setItems((current) => current.filter((item) => item.id !== listingId))
  }, [])

  const setQuantity = useCallback((listingId, quantity) => {
    const amount = Number(quantity)
    if (!Number.isFinite(amount) || amount < 1) return

    setItems((current) =>
      current.map((item) =>
        item.id === listingId
          ? {
              ...item,
              quantity: Math.min(
                Math.floor(amount),
                99,
                Math.max(1, Number(item.stock ?? 99)),
              ),
            }
          : item,
      ),
    )
  }, [])

  const clearCart = useCallback(() => setItems([]), [])

  const { count, subtotal } = useMemo(() => {
    return items.reduce(
      (acc, item) => {
        acc.count += item.quantity
        acc.subtotal += Number(item.price) * item.quantity
        return acc
      },
      { count: 0, subtotal: 0 },
    )
  }, [items])

  const value = useMemo(
    () => ({
      items,
      count,
      subtotal,
      addItem,
      removeItem,
      setQuantity,
      clearCart,
    }),
    [items, count, subtotal, addItem, removeItem, setQuantity, clearCart],
  )

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart() {
  const context = useContext(CartContext)
  if (!context) {
    throw new Error('useCart must be used inside <CartProvider>')
  }
  return context
}
