# Round 3 TASK5 — Translation (中英日三语翻译) 原始答案

## qwen3-coder-plus
**耗时: 8612ms**

**1. 英文版：**

"In event-driven architecture (EDA), the CQRS pattern separates read and write operations into different models for processing. The command side records all state changes through event sourcing, while the query side maintains materialized views to optimize read performance. Eventual consistency is a core characteristic of this architecture—after write confirmation, the read side may require several milliseconds to several seconds of delay before reflecting the latest state. Compensating transactions are used to handle business rollbacks in distributed scenarios."

**2. 日文版：**

「イベント駆動アーキテクチャ（EDA）において、CQRSパターンは読み取り操作と書き込み操作を異なるモデルに分離して処理します。コマンドサイドはイベントソーシングを通じてすべての状態変更を記録し、クエリサイドはマテリアライズドビューを維持して読み取りパフォーマンスを最適化します。最終的一貫性（Eventual Consistency）はこのアーキテクチャの中核的特徴です。書き込み確認後、最新の状態を反映させるために読み取り側が数ミリ秒から数秒の遅延を必要とする場合があります。補償トランザクション（Compensating Transaction）は分散環境におけるビジネスロールバックを処理するために使用されます。」

**3. 英文版回译为中文版：**

"在事件驱动架构（EDA）中，CQRS模式将读写操作分离到不同的模型中处理。命令端通过事件溯源记录所有状态变化，而查询端则维护物化视图以优化读取性能。最终一致性是这种架构的核心特征——在写入确认后，读取端可能需要几毫秒到几秒的延迟才能反映最新状态。补偿事务用于处理分布式场景中的业务回滚。"
