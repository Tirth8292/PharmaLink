export function calculateCartTotal(cartItems) {
  return cartItems.reduce((sum, item) => sum + Number(item.medicines?.price || 0) * item.quantity, 0);
}

export function getSuggestedMedicines(medicines, cartItems) {
  const cartIds = new Set(cartItems.map((item) => item.product_id));
  const categories = new Set(cartItems.map((item) => item.medicines?.category).filter(Boolean));
  return medicines
    .filter((medicine) => !cartIds.has(medicine.id) && medicine.stock > 0)
    .sort((a, b) => {
      const aScore = categories.has(a.category) ? 0 : 1;
      const bScore = categories.has(b.category) ? 0 : 1;
      if (aScore !== bScore) return aScore - bScore;
      return Number(a.price) - Number(b.price);
    })
    .slice(0, 4);
}

export const ORDER_TIMELINE = ['Placed', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered'];
