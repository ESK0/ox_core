import { db } from 'db';
import { OxPlayer } from 'player/class';
import type { OxAccount } from 'types';
import locales from '../../common/locales';
import { getRandomInt } from '@overextended/ox_lib';

const addBalance = `UPDATE accounts SET balance = balance + ? WHERE id = ?`;
const removeBalance = `UPDATE accounts SET balance = balance - ? WHERE id = ?`;
const safeRemoveBalance = `${removeBalance} AND (balance - ?) >= 0`;
const addTransaction = `INSERT INTO accounts_transactions (actorId, fromId, toId, amount, message, note, fromBalance, toBalance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const getBalance = `SELECT balance FROM accounts WHERE id = ?`;

async function GenerateAccountId() {
  const arr = [];

  while (true) {
    arr[0] = getRandomInt(1, 9);
    for (let i = 1; i < 6; i++) arr[i] = getRandomInt();

    const accountId = Number(arr.join(''));

    if (await IsAccountIdAvailable(accountId)) return accountId;
  }
}

export async function UpdateBalance(id: number, amount: number, action: 'add' | 'remove', overdraw: boolean, message?: string) {
  return (
    (await db.update(action === 'add' ? addBalance : overdraw ? removeBalance : safeRemoveBalance, [amount, id, amount])) === 1 &&
    (await db.update(addTransaction, [action === 'add' ? null : id, action === 'add' ? id : null, amount, message])) === 1
  );
}

export async function PerformTransaction(fromId: number, toId: number, amount: number, overdraw: boolean, actorId?: number, message?: string, note?: string) {
  using conn = await db.getConnection();

  const fromBalance = db.scalar<number>(await conn.execute(getBalance, [fromId]));
  const toBalance = db.scalar<number>(await conn.execute(getBalance, [toId]));
  if (fromBalance == undefined || toBalance == undefined) return;

  await conn.beginTransaction();

  try {
    const a = (await conn.execute(overdraw ? removeBalance : safeRemoveBalance, [amount, fromId, amount])).affectedRows === 1;
    const b = (await conn.execute(addBalance, [amount, toId])).affectedRows === 1;

    if (a && b) {
      await conn.execute(addTransaction, [actorId, fromId, toId, amount, message ?? locales('transfer'), note, fromBalance - amount, toBalance + amount]);
      await conn.commit();
      return true;
    }
  } catch (e) {
    console.error(`Failed to transfer $${amount} from account<${fromId}> to account<${toId}>`);
    console.log(e);
  }

  conn.rollback();

  return false;
}

export async function SelectAccounts(column: 'owner' | 'group' | 'id', id: number | string) {
  return db.execute<OxAccount>(`SELECT * FROM accounts WHERE \`${column}\` = ?`, [id]);
}

export async function SelectDefaultAccount(column: 'owner' | 'group' | 'id', id: number | string) {
  return await db.row<OxAccount>(`SELECT * FROM accounts WHERE \`${column}\` = ? AND isDefault = 1`, [id]);
}

export async function SelectAccount(id: number) {
  return db.single(await SelectAccounts('id', id));
}

export async function SelectAllAccounts(id: number) {
  return await db.execute<OxAccount>(
    'SELECT ac.role, a.* FROM `accounts_access` ac LEFT JOIN accounts a ON a.id = ac.accountId WHERE ac.charId = ?',
    [id]
  );
}

export async function IsAccountIdAvailable(id: number) {
  return !(await db.exists('SELECT 1 FROM accounts WHERE id = ?', [id]));
}

export async function CreateNewAccount(column: 'owner' | 'group', id: string | number, label: string, shared?: boolean, isDefault?: boolean) {
  const accountId = await GenerateAccountId();
  const result = await db.insert(`INSERT INTO accounts (id, label, \`${column}\`, type, isDefault) VALUES (?, ?, ?, ?, ?)`, [
    accountId,
    label,
    id,
    shared ? 'shared' : 'personal',
    isDefault || 0,
  ]);

  if (result)
    db.insert(`INSERT INTO accounts_access (accountId, charId, role) VALUE (?, ?, ?)`, [accountId, id, 'owner']);

  return accountId;
}

export function DeleteAccount(accountId: number) {
  return db.update(`DELETE FROM accounts WHERE id = ?`, [accountId]);
}

const selectAccountRole = `SELECT role FROM accounts_access WHERE accountId = ? AND charId = ?`;

export function SelectAccountRole(accountId: number, charId: number) {
  return db.column<OxAccount['role']>(selectAccountRole, [accountId, charId]);
}

export async function DepositMoney(playerId: number, accountId: number, amount: number, message?: string) {
  const { charId } = OxPlayer.get(playerId);

  if (!charId) return;

  const money = exports.ox_inventory.GetItemCount(playerId, 'money');

  if (amount > money) return;

  using conn = await db.getConnection();

  const role = db.scalar<string>(await conn.execute(selectAccountRole, [accountId, charId]));

  if (role !== 'owner') return;

  const balance = db.scalar<number>(await conn.execute(getBalance, [accountId]));
  if (!balance) return;

  await conn.beginTransaction();

  const { affectedRows } = await conn.execute(addBalance, [amount, accountId]);

  if (!affectedRows || !exports.ox_inventory.RemoveItem(playerId, 'money', amount)) {
    conn.rollback();
    return false;
  }

  await conn.execute(addTransaction, [null, accountId, amount, message ?? locales('deposit'), null, balance + amount]);
  conn.commit();
  return true;
}

export async function WithdrawMoney(playerId: number, accountId: number, amount: number, message?: string) {
  const { charId } = OxPlayer.get(playerId);

  if (!charId) return;

  using conn = await db.getConnection();

  const role = db.scalar<string>(await conn.execute(selectAccountRole, [accountId, charId]));

  if (role !== 'owner' && role !== 'manager') return;

  const balance = db.scalar<number>(await conn.execute(getBalance, [accountId]));
  if (!balance) return;

  await conn.beginTransaction();

  const { affectedRows } = await conn.execute(safeRemoveBalance, [amount, accountId, amount]);

  if (!affectedRows || !exports.ox_inventory.AddItem(playerId, 'money', amount)) {
    conn.rollback();
    return false;
  }
  await conn.execute(addTransaction, [accountId, null, amount, message ?? locales('withdraw'), balance - amount, null]);
  conn.commit();
  return true;
}

export function UpdateAccountAccess(accountId: number, id: number, role?: string) {
  if (!role) return db.update(`DELETE FROM accounts_access WHERE accountId = ? AND charId = ?`, [accountId, id]);

  return db.update(
    `INSERT INTO accounts_access (accountId, charId, role) VALUE (?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)`,
    [accountId, id, role]
  );
}