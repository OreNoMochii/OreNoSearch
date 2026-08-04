import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.model_selection import train_test_split

def generate_ltr_data(n_queries=100, candidates_per_query=50):
    """
    Simulate the output of the Feature Engineering pipeline for LTR.
    Each query represents a JD. The model learns to rank candidates for that JD.
    """
    np.random.seed(42)
    
    n_samples = n_queries * candidates_per_query
    
    qids = np.repeat(np.arange(n_queries), candidates_per_query)
    
    # Feature 1: BM25/Cosine Similarity of JD to Candidate (Base Stage 1 score)
    embedding_sim = np.random.uniform(0.3, 0.9, n_samples)
    
    # Feature 2: Years of Experience difference (Absolute difference from required)
    yoe_diff = np.random.exponential(scale=3, size=n_samples) # Penalty
    
    # Feature 3: Skill overlap percentage (0.0 to 1.0)
    skill_overlap = np.random.uniform(0.0, 1.0, n_samples)
    
    # Label: Relevancy Score (0 = Bad, 1 = Okay, 2 = Great, 3 = Perfect Match)
    # We construct a noisy true label based on the features
    raw_score = (embedding_sim * 2.0) + (skill_overlap * 3.0) - (yoe_diff * 0.5)
    
    # Bin into discrete relevancy classes [0, 1, 2, 3]
    labels = pd.qcut(raw_score, q=4, labels=[0, 1, 2, 3]).to_numpy(dtype=int)
    
    # Introduce some noise to make the task non-trivial
    noise_mask = np.random.binomial(1, p=0.1, size=n_samples).astype(bool)
    labels[noise_mask] = np.random.choice([0, 1, 2, 3], size=np.sum(noise_mask))
    
    df = pd.DataFrame({
        'qid': qids,
        'embedding_sim': embedding_sim,
        'yoe_diff': yoe_diff,
        'skill_overlap': skill_overlap,
        'relevance_label': labels
    })
    
    # XGBoost requires data to be sorted by qid for ranking tasks
    df = df.sort_values(by='qid')
    return df

def train_ltr_model():
    print("Generating/Loading LTR Pairs...")
    df = generate_ltr_data()
    
    # Split queries (not individual rows) to avoid data leakage
    unique_qids = df['qid'].unique()
    train_qids, test_qids = train_test_split(unique_qids, test_size=0.2, random_state=42)
    
    train_df = df[df['qid'].isin(train_qids)].copy()
    test_df = df[df['qid'].isin(test_qids)].copy()
    
    X_train = train_df[['embedding_sim', 'yoe_diff', 'skill_overlap']]
    y_train = train_df['relevance_label']
    group_train = train_df.groupby('qid').size().values
    
    X_test = test_df[['embedding_sim', 'yoe_diff', 'skill_overlap']]
    y_test = test_df['relevance_label']
    group_test = test_df.groupby('qid').size().values
    
    print("Training XGBoost Ranker (LambdaMART)...")
    # objective 'rank:ndcg' optimizes Normalized Discounted Cumulative Gain
    ranker = xgb.XGBRanker(
        tree_method='hist',
        objective='rank:ndcg',
        n_estimators=100,
        learning_rate=0.1,
        max_depth=4,
        random_state=42
    )
    
    ranker.fit(
        X_train, y_train, group=group_train,
        eval_set=[(X_test, y_test)],
        eval_group=[group_test],
        verbose=False
    )
    
    # Evaluate accuracy using NDCG
    results = ranker.evals_result()
    final_ndcg = list(results['validation_0'].values())[0][-1]  # Get the first metric (ndcg)
    
    print("\n=== LTR Model Performance ===")
    print(f"NDCG Score (Ranking Accuracy): {final_ndcg:.4f}")
    
    # Feature importances
    print("\n=== Feature Importance (Gain) ===")
    importance = ranker.get_booster().get_score(importance_type='gain')
    for feat, imp in importance.items():
        print(f"{feat}: {imp:.4f}")

if __name__ == "__main__":
    train_ltr_model()
