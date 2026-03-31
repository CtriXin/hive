/**
 * AgentBus Schema Validation Tests
 */

import { describe, it, expect } from 'vitest';
import {
  ReceiptStateEnum,
  RoomStatusEnum,
  ParticipantSchema,
  MessageSchema,
  ReceiptSchema,
  RoomStateSchema,
  ManifestSchema,
} from '../../src/agentbus/schema.js';

describe('Schema Validation', () => {
  describe('ReceiptState', () => {
    it('should accept valid states', () => {
      expect(ReceiptStateEnum.parse('PROCESSING')).toBe('PROCESSING');
      expect(ReceiptStateEnum.parse('ANSWERED')).toBe('ANSWERED');
      expect(ReceiptStateEnum.parse('TIMEOUT')).toBe('TIMEOUT');
      expect(ReceiptStateEnum.parse('ERROR')).toBe('ERROR');
    });

    it('should reject DELIVERED (not in schema)', () => {
      expect(() => ReceiptStateEnum.parse('DELIVERED')).toThrow();
    });

    it('should reject invalid states', () => {
      expect(() => ReceiptStateEnum.parse('INVALID')).toThrow();
    });
  });

  describe('Participant', () => {
    it('should validate valid participant', () => {
      const participant = {
        participant_id: 'worker-1',
        model_id: 'gpt-4',
        role: 'worker',
        joined_at: Date.now(),
        cursor: 0,
      };
      expect(() => ParticipantSchema.parse(participant)).not.toThrow();
    });

    it('should reject empty participant_id', () => {
      const participant = {
        participant_id: '',
        model_id: 'gpt-4',
        role: 'worker',
        joined_at: Date.now(),
        cursor: 0,
      };
      expect(() => ParticipantSchema.parse(participant)).toThrow();
    });

    it('should reject invalid role', () => {
      const participant = {
        participant_id: 'worker-1',
        model_id: 'gpt-4',
        role: 'invalid-role',
        joined_at: Date.now(),
        cursor: 0,
      };
      expect(() => ParticipantSchema.parse(participant)).toThrow();
    });
  });

  describe('Message', () => {
    it('should validate valid message', () => {
      const message = {
        seq: 1,
        msg_id: 'msg-123',
        msg_type: 'broadcast',
        from: 'orch-1',
        to: '*',
        payload: { question: 'test' },
        timestamp: Date.now(),
      };
      expect(() => MessageSchema.parse(message)).not.toThrow();
    });

    it('should validate directed message', () => {
      const message = {
        seq: 1,
        msg_id: 'msg-123',
        msg_type: 'directed',
        from: 'orch-1',
        to: 'worker-1',
        payload: { task: 'test' },
        timestamp: Date.now(),
      };
      expect(() => MessageSchema.parse(message)).not.toThrow();
    });

    it('should reject negative seq', () => {
      const message = {
        seq: -1,
        msg_id: 'msg-123',
        msg_type: 'broadcast',
        from: 'orch-1',
        to: '*',
        payload: {},
        timestamp: Date.now(),
      };
      expect(() => MessageSchema.parse(message)).toThrow();
    });
  });

  describe('Receipt', () => {
    it('should validate valid receipt', () => {
      const receipt = {
        receipt_id: 'rcpt-123',
        msg_id: 'msg-123',
        participant_id: 'worker-1',
        state: 'ANSWERED',
        answer_seq: 2,
        timestamp: Date.now(),
      };
      expect(() => ReceiptSchema.parse(receipt)).not.toThrow();
    });

    it('should validate error receipt without answer_seq', () => {
      const receipt = {
        receipt_id: 'rcpt-123',
        msg_id: 'msg-123',
        participant_id: 'worker-1',
        state: 'ERROR',
        error: 'Something went wrong',
        timestamp: Date.now(),
      };
      expect(() => ReceiptSchema.parse(receipt)).not.toThrow();
    });
  });

  describe('Manifest', () => {
    it('should validate valid manifest', () => {
      const manifest = {
        version: '1.0',
        room: {
          room_id: 'room-123',
          status: 'OPEN',
          created_at: Date.now(),
          created_by: 'orch-1',
          participants: [],
          message_seq: 0,
        },
        last_updated: Date.now(),
      };
      expect(() => ManifestSchema.parse(manifest)).not.toThrow();
    });

    it('should reject invalid version', () => {
      const manifest = {
        version: '2.0',
        room: {
          room_id: 'room-123',
          status: 'OPEN',
          created_at: Date.now(),
          created_by: 'orch-1',
          participants: [],
          message_seq: 0,
        },
        last_updated: Date.now(),
      };
      expect(() => ManifestSchema.parse(manifest)).toThrow();
    });
  });
});
