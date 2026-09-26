//! Breadth-first positions from a sealed store's own child ranges (design §S.1.5; §S.2,
//! Lemma 3): the order `build`'s ids follow, which a block-numbered store's ids do not.
//! A hard-link family's winner, and the order of the cloud candidates and of the sparse
//! terms, are `build`'s only when they are taken in this order.

use std::collections::VecDeque;

use crate::StoreError;

/// The breadth-first positions of `wanted`'s nodes — the ids `build` gives the same
/// nodes — in `wanted`'s order; `wanted` ascending, without repeats. The root is position
/// 0, and each folder's children take the next positions in child order, folder after
/// folder in the order they were reached, exactly as `build` numbers them. The queue holds
/// only the folders that have children; a node that no child range reaches is refused.
fn breadth_first_ranks(
    child_start: &[u32],
    child_cnt: &[u32],
    wanted: &[u32],
) -> Result<Vec<u32>, StoreError> {
    let rows = child_start.len();
    let mut ranks = vec![u32::MAX; wanted.len()];
    if wanted.first() == Some(&0)
        && let Some(root) = ranks.first_mut()
    {
        *root = 0;
    }
    let mut queue = VecDeque::from([0_u32]);
    let mut next: u32 = 1;
    while let Some(folder) = queue.pop_front() {
        let at = folder as usize;
        let (Some(&start), Some(&count)) = (child_start.get(at), child_cnt.get(at)) else {
            return Err(StoreError::Sink(format!(
                "folder {folder} is past the store's {rows} rows"
            )));
        };
        let end = start
            .checked_add(count)
            .filter(|&end| end as usize <= rows)
            .ok_or_else(|| {
                StoreError::Sink(format!(
                    "folder {folder}'s children run past the store's {rows} rows"
                ))
            })?;
        let after = next.checked_add(count).ok_or_else(|| {
            StoreError::Sink("the breadth-first positions pass u32::MAX".to_owned())
        })?;
        let from = wanted.partition_point(|&id| id < start);
        let to = wanted.partition_point(|&id| id < end);
        let slots = ranks.get_mut(from..to).unwrap_or_default();
        for (slot, &id) in slots
            .iter_mut()
            .zip(wanted.get(from..to).unwrap_or_default())
        {
            // `start <= id < end`, so the position is below `after`.
            *slot = next + (id - start);
        }
        for child in start..end {
            if child_cnt
                .get(child as usize)
                .is_some_and(|&children| children > 0)
            {
                queue.push_back(child);
            }
        }
        next = after;
    }
    if let Some((&id, _)) = wanted
        .iter()
        .zip(&ranks)
        .find(|&(_, &rank)| rank == u32::MAX)
    {
        return Err(StoreError::Sink(format!(
            "node {id} is in no child range reached from the root"
        )));
    }
    Ok(ranks)
}

/// The breadth-first places of the rows a seal asks about.
pub(super) struct Places {
    /// The rows asked about, ascending, without repeats.
    rows: Vec<u32>,
    /// Their places, in `rows`' order.
    places: Vec<u32>,
}

impl Places {
    /// The places of `rows` (in any order, repeats allowed) in the store whose child
    /// ranges these are.
    pub(super) fn of(
        child_start: &[u32],
        child_cnt: &[u32],
        mut rows: Vec<u32>,
    ) -> Result<Self, StoreError> {
        rows.sort_unstable();
        rows.dedup();
        let places = breadth_first_ranks(child_start, child_cnt, &rows)?;
        Ok(Self { rows, places })
    }

    /// Row `id`'s place: the id `build` gives it. A row not asked about is refused.
    pub(super) fn of_row(&self, id: u32) -> Result<u32, StoreError> {
        self.rows
            .binary_search(&id)
            .ok()
            .and_then(|at| self.places.get(at).copied())
            .ok_or_else(|| StoreError::Sink(format!("row {id} has no breadth-first place")))
    }

    /// `items` in the breadth-first order of the row each one names (`id`): `build`'s
    /// order for a list it gathers in id order. Stable, so items naming one row keep their
    /// order.
    pub(super) fn sort<T>(
        &self,
        items: Vec<T>,
        id: impl Fn(&T) -> u32,
    ) -> Result<Vec<T>, StoreError> {
        let mut placed = items
            .into_iter()
            .map(|item| Ok((self.of_row(id(&item))?, item)))
            .collect::<Result<Vec<_>, StoreError>>()?;
        placed.sort_by_key(|&(place, _)| place);
        Ok(placed.into_iter().map(|(_, item)| item).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::breadth_first_ranks;

    /// A store whose ids are not breadth-first: the root's children are 1 and 2; folder 2
    /// holds 3 and 4, folder 1 holds 5 and 6, and folder 6 holds 7 (a walk that listed
    /// folder 2 before folder 1 numbers them so). Breadth-first, `build` numbers them 0,
    /// 1, 2, then folder 1's children 3 and 4, then folder 2's 5 and 6, then folder 6's 7.
    const CHILD_START: [u32; 8] = [1, 5, 3, 7, 7, 7, 7, 8];
    const CHILD_CNT: [u32; 8] = [2, 2, 2, 0, 0, 0, 1, 0];

    #[test]
    fn positions_are_the_ids_build_gives_the_same_nodes() -> Result<(), String> {
        let every: Vec<u32> = (0..8).collect();
        let ranks =
            breadth_first_ranks(&CHILD_START, &CHILD_CNT, &every).map_err(|e| e.to_string())?;
        assert_eq!(ranks, vec![0, 1, 2, 5, 6, 3, 4, 7]);
        Ok(())
    }

    #[test]
    fn only_the_nodes_asked_for_are_answered_in_the_order_asked() -> Result<(), String> {
        let ranks =
            breadth_first_ranks(&CHILD_START, &CHILD_CNT, &[3, 5, 7]).map_err(|e| e.to_string())?;
        assert_eq!(ranks, vec![5, 3, 7]);
        let root =
            breadth_first_ranks(&CHILD_START, &CHILD_CNT, &[0]).map_err(|e| e.to_string())?;
        assert_eq!(root, vec![0]);
        Ok(())
    }

    #[test]
    fn a_child_range_past_the_rows_or_a_node_never_reached_is_refused() {
        let mut past = CHILD_CNT;
        past[6] = 5;
        assert!(breadth_first_ranks(&CHILD_START, &past, &[7]).is_err());
        let mut cut = CHILD_CNT;
        cut[6] = 0;
        assert!(breadth_first_ranks(&CHILD_START, &cut, &[7]).is_err());
    }
}
